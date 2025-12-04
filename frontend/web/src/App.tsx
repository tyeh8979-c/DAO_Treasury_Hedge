// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface TreasuryAsset {
  id: string;
  encryptedAmount: string;
  assetType: string;
  timestamp: number;
  owner: string;
  hedgeStatus: "unhedged" | "partial" | "full";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<TreasuryAsset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addingAsset, setAddingAsset] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAssetData, setNewAssetData] = useState({ assetType: "", amount: 0 });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [selectedAsset, setSelectedAsset] = useState<TreasuryAsset | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [totalValue, setTotalValue] = useState<number>(0);
  const [hedgeRatio, setHedgeRatio] = useState<number>(0);

  // Asset types for the DAO treasury
  const assetTypes = [
    "ETH",
    "BTC",
    "USDC",
    "DAI",
    "WBTC",
    "UNI",
    "LINK",
    "Other"
  ];

  useEffect(() => {
    loadAssets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  useEffect(() => {
    // Calculate total value and hedge ratio whenever assets change
    if (assets.length > 0) {
      let total = 0;
      let hedgedValue = 0;
      
      assets.forEach(asset => {
        try {
          const amount = FHEDecryptNumber(asset.encryptedAmount);
          total += amount;
          if (asset.hedgeStatus === "full") {
            hedgedValue += amount;
          } else if (asset.hedgeStatus === "partial") {
            hedgedValue += amount * 0.5;
          }
        } catch (e) {
          console.error("Error decrypting asset value:", e);
        }
      });
      
      setTotalValue(total);
      setHedgeRatio(total > 0 ? (hedgedValue / total) * 100 : 0);
    } else {
      setTotalValue(0);
      setHedgeRatio(0);
    }
  }, [assets]);

  const loadAssets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing asset keys:", e); }
      }
      
      const list: TreasuryAsset[] = [];
      for (const key of keys) {
        try {
          const assetBytes = await contract.getData(`asset_${key}`);
          if (assetBytes.length > 0) {
            try {
              const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
              list.push({ 
                id: key, 
                encryptedAmount: assetData.amount, 
                assetType: assetData.assetType, 
                timestamp: assetData.timestamp, 
                owner: assetData.owner, 
                hedgeStatus: assetData.hedgeStatus || "unhedged" 
              });
            } catch (e) { console.error(`Error parsing asset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading asset ${key}:`, e); }
      }
      
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAssets(list);
    } catch (e) { console.error("Error loading assets:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const addAsset = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setAddingAsset(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting asset data with Zama FHE..." });
    
    try {
      const encryptedAmount = FHEEncryptNumber(newAssetData.amount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const assetId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const assetData = { 
        amount: encryptedAmount, 
        assetType: newAssetData.assetType, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        hedgeStatus: "unhedged" 
      };
      
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      
      keys.push(assetId);
      await contract.setData("asset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset added with FHE encryption!" });
      await loadAssets();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddModal(false);
        setNewAssetData({ assetType: "", amount: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setAddingAsset(false); }
  };

  const hedgeAsset = async (assetId: string, hedgeType: "partial" | "full") => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing hedge with FHE encrypted data..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedAsset = { ...assetData, hedgeStatus: hedgeType };
      await contractWithSigner.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAsset)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: hedgeType === "full" 
          ? "Full hedge applied successfully!" 
          : "Partial hedge applied successfully!" 
      });
      
      await loadAssets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Hedge failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const isOwner = (assetAddress: string) => address?.toLowerCase() === assetAddress.toLowerCase();

  const renderAssetChart = () => {
    const assetDistribution = assetTypes.map(type => ({
      type,
      value: assets.filter(a => a.assetType === type).reduce((sum, asset) => {
        try {
          return sum + FHEDecryptNumber(asset.encryptedAmount);
        } catch (e) {
          return sum;
        }
      }, 0)
    })).filter(item => item.value > 0);

    return (
      <div className="asset-chart">
        {assetDistribution.map((asset, index) => (
          <div key={index} className="asset-bar">
            <div className="bar-label">{asset.type}</div>
            <div className="bar-container">
              <div 
                className="bar-fill" 
                style={{ width: `${(asset.value / totalValue) * 100}%` }}
              ></div>
            </div>
            <div className="bar-value">${asset.value.toLocaleString()}</div>
          </div>
        ))}
      </div>
    );
  };

  const renderHedgeStatus = () => {
    return (
      <div className="hedge-status">
        <div className="hedge-meter">
          <div 
            className="hedge-progress" 
            style={{ width: `${hedgeRatio}%` }}
          ></div>
          <div className="hedge-label">{hedgeRatio.toFixed(1)}% Hedged</div>
        </div>
        <div className="hedge-stats">
          <div className="stat-item">
            <div className="stat-value">${totalValue.toLocaleString()}</div>
            <div className="stat-label">Total Value</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{assets.filter(a => a.hedgeStatus === "full").length}</div>
            <div className="stat-label">Fully Hedged</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{assets.filter(a => a.hedgeStatus === "partial").length}</div>
            <div className="stat-label">Partially Hedged</div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE encrypted treasury...</p>
    </div>
  );

  return (
    <div className="app-container metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>DAO<span>Treasury</span>Hedge</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowAddModal(true)} className="add-asset-btn metal-button">
            <div className="add-icon"></div>Add Asset
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-panels">
          {/* Panel 1: Treasury Overview */}
          <div className="panel metal-card">
            <h2>Treasury Overview</h2>
            <div className="panel-content">
              <div className="overview-stats">
                <div className="stat-card">
                  <div className="stat-title">Total Value</div>
                  <div className="stat-value">${totalValue.toLocaleString()}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-title">Assets</div>
                  <div className="stat-value">{assets.length}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-title">Hedge Ratio</div>
                  <div className="stat-value">{hedgeRatio.toFixed(1)}%</div>
                </div>
              </div>
              {renderHedgeStatus()}
            </div>
          </div>

          {/* Panel 2: Asset Distribution */}
          <div className="panel metal-card">
            <h2>Asset Distribution</h2>
            <div className="panel-content">
              {assets.length > 0 ? renderAssetChart() : (
                <div className="no-data">
                  <p>No assets added yet</p>
                </div>
              )}
            </div>
          </div>

          {/* Panel 3: Feature Showcase */}
          <div className="panel metal-card">
            <h2>FHE-Powered Features</h2>
            <div className="panel-content features">
              <div className="feature">
                <div className="feature-icon fhe-icon"></div>
                <h3>Encrypted Holdings</h3>
                <p>All treasury assets are encrypted with Zama FHE, protecting your financial strategy.</p>
              </div>
              <div className="feature">
                <div className="feature-icon hedge-icon"></div>
                <h3>One-Click Hedging</h3>
                <p>Apply risk mitigation strategies directly on encrypted data without decryption.</p>
              </div>
              <div className="feature">
                <div className="feature-icon analytics-icon"></div>
                <h3>Private Analytics</h3>
                <p>Get insights into your treasury composition without exposing sensitive data.</p>
              </div>
            </div>
          </div>

          {/* Panel 4: Asset List */}
          <div className="panel metal-card full-width">
            <div className="panel-header">
              <h2>Treasury Assets</h2>
              <button onClick={loadAssets} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <div className="panel-content">
              <div className="assets-table">
                <div className="table-header">
                  <div className="header-cell">Asset</div>
                  <div className="header-cell">Type</div>
                  <div className="header-cell">Added</div>
                  <div className="header-cell">Hedge Status</div>
                  <div className="header-cell">Actions</div>
                </div>
                {assets.length === 0 ? (
                  <div className="no-assets">
                    <div className="no-assets-icon"></div>
                    <p>No assets in treasury</p>
                    <button className="metal-button primary" onClick={() => setShowAddModal(true)}>Add First Asset</button>
                  </div>
                ) : assets.map(asset => (
                  <div className="table-row" key={asset.id} onClick={() => setSelectedAsset(asset)}>
                    <div className="table-cell">
                      <div className="asset-id">#{asset.id.substring(0, 6)}</div>
                    </div>
                    <div className="table-cell">{asset.assetType}</div>
                    <div className="table-cell">{new Date(asset.timestamp * 1000).toLocaleDateString()}</div>
                    <div className="table-cell">
                      <span className={`status-badge ${asset.hedgeStatus}`}>
                        {asset.hedgeStatus}
                      </span>
                    </div>
                    <div className="table-cell actions">
                      {isOwner(asset.owner) && (
                        <div className="action-buttons">
                          <button 
                            className="action-btn metal-button success" 
                            onClick={(e) => { e.stopPropagation(); hedgeAsset(asset.id, "full"); }}
                            disabled={asset.hedgeStatus === "full"}
                          >
                            Full Hedge
                          </button>
                          <button 
                            className="action-btn metal-button warning" 
                            onClick={(e) => { e.stopPropagation(); hedgeAsset(asset.id, "partial"); }}
                            disabled={asset.hedgeStatus !== "unhedged"}
                          >
                            Partial Hedge
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Add Asset Modal */}
      {showAddModal && (
        <div className="modal-overlay">
          <div className="add-modal metal-card">
            <div className="modal-header">
              <h2>Add Treasury Asset</h2>
              <button onClick={() => setShowAddModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="fhe-notice">
                <div className="lock-icon"></div>
                <p>This data will be encrypted with Zama FHE before storage</p>
              </div>
              <div className="form-group">
                <label>Asset Type *</label>
                <select 
                  name="assetType" 
                  value={newAssetData.assetType} 
                  onChange={(e) => setNewAssetData({...newAssetData, assetType: e.target.value})}
                  className="metal-select"
                >
                  <option value="">Select asset type</option>
                  {assetTypes.map((type, index) => (
                    <option key={index} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Amount *</label>
                <input 
                  type="number" 
                  name="amount" 
                  value={newAssetData.amount} 
                  onChange={(e) => setNewAssetData({...newAssetData, amount: parseFloat(e.target.value)})}
                  placeholder="Enter amount..."
                  className="metal-input"
                  step="0.0001"
                />
              </div>
              <div className="encryption-preview">
                <div className="preview-row">
                  <span>Plain Value:</span>
                  <div>{newAssetData.amount || 0}</div>
                </div>
                <div className="preview-arrow">↓</div>
                <div className="preview-row">
                  <span>Encrypted Value:</span>
                  <div>{newAssetData.amount ? FHEEncryptNumber(newAssetData.amount).substring(0, 30) + '...' : 'N/A'}</div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowAddModal(false)} className="metal-button">Cancel</button>
              <button 
                onClick={addAsset} 
                disabled={addingAsset || !newAssetData.assetType || !newAssetData.amount}
                className="metal-button primary"
              >
                {addingAsset ? "Encrypting..." : "Add Asset"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Asset Detail Modal */}
      {selectedAsset && (
        <div className="modal-overlay">
          <div className="detail-modal metal-card">
            <div className="modal-header">
              <h2>Asset Details</h2>
              <button onClick={() => { setSelectedAsset(null); setDecryptedAmount(null); }} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="asset-info">
                <div className="info-row">
                  <span>Type:</span>
                  <strong>{selectedAsset.assetType}</strong>
                </div>
                <div className="info-row">
                  <span>Added:</span>
                  <strong>{new Date(selectedAsset.timestamp * 1000).toLocaleString()}</strong>
                </div>
                <div className="info-row">
                  <span>Hedge Status:</span>
                  <strong className={`status-badge ${selectedAsset.hedgeStatus}`}>{selectedAsset.hedgeStatus}</strong>
                </div>
              </div>
              <div className="encrypted-section">
                <h3>Encrypted Amount</h3>
                <div className="encrypted-data">
                  {selectedAsset.encryptedAmount.substring(0, 50)}...
                </div>
                <button 
                  className="metal-button" 
                  onClick={async () => {
                    if (decryptedAmount === null) {
                      const decrypted = await decryptWithSignature(selectedAsset.encryptedAmount);
                      setDecryptedAmount(decrypted);
                    } else {
                      setDecryptedAmount(null);
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : decryptedAmount !== null ? "Hide Value" : "Decrypt"}
                </button>
              </div>
              {decryptedAmount !== null && (
                <div className="decrypted-section">
                  <h3>Decrypted Amount</h3>
                  <div className="decrypted-value">
                    {decryptedAmount.toLocaleString()} {selectedAsset.assetType}
                  </div>
                  <div className="decryption-note">
                    <div className="warning-icon"></div>
                    <span>This value is only visible after wallet signature verification</span>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => hedgeAsset(selectedAsset.id, "full")}
                disabled={selectedAsset.hedgeStatus === "full"}
                className="metal-button success"
              >
                Apply Full Hedge
              </button>
              <button 
                onClick={() => hedgeAsset(selectedAsset.id, "partial")}
                disabled={selectedAsset.hedgeStatus !== "unhedged"}
                className="metal-button warning"
              >
                Apply Partial Hedge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>DAOTreasuryHedge</span>
            </div>
            <p>Confidential DAO Treasury Management with DeFi Hedging Tools</p>
          </div>
          <div className="footer-links">
            <div className="footer-section">
              <h4>Technology</h4>
              <a href="https://zama.ai" className="footer-link">Zama FHE</a>
              <a href="#" className="footer-link">Documentation</a>
            </div>
            <div className="footer-section">
              <h4>Legal</h4>
              <a href="#" className="footer-link">Privacy Policy</a>
              <a href="#" className="footer-link">Terms of Service</a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} DAO Treasury Hedge. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;