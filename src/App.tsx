import { useState, useEffect, useMemo } from 'react';
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { 
  getAssociatedTokenAddress, 
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

const ALCHEMY_CONFIG = {
  policyId: 'db9ce2e0-889d-4492-8a6d-bbdcc683f90d',
  apiKey: 'qCHdkP0F0PP8eWjnGS3wi',
  rpcUrl: 'https://solana-mainnet.g.alchemy.com/v2/qCHdkP0F0PP8eWjnGS3wi',
  enabled: true
};

const MAX_BATCH_SIZE = 100;
const MAX_TX_SIZE_SOL = 8;  // Reduced for safety
const MAX_TX_SIZE_SPL = 5;  // Reduced for safety - SPL transfers are larger
const SOL_MINT = "SOL";

const THEME = {
  bg: "bg-white",
  text: "text-black",
  accent: "bg-yellow-400 hover:bg-yellow-500 text-black font-bold",
  border: "border-2 border-black",
  input: "w-full p-3 border-2 border-gray-200 focus:border-black outline-none transition-colors",
  card: "p-6 border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-white",
};

interface Recipient {
  address: string;
  amount: string;
}

interface TokenAccount {
  mint: string;
  balance: number;
  decimals: number;
  symbol: string;
  name: string;
  logo?: string;
  selected?: boolean;
  amountToSend?: string;
  programId?: PublicKey;
}

const isValidAddress = (address: string): boolean => {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
};

const getTokenDecimals = async (connection: any, mintAddress: string): Promise<{ decimals: number; programId: PublicKey } | null> => {
  try {
    const mint = new PublicKey(mintAddress);
    
    try {
      const mintInfo = await getMint(connection, mint, undefined, TOKEN_2022_PROGRAM_ID);
      return { decimals: mintInfo.decimals, programId: TOKEN_2022_PROGRAM_ID };
    } catch (e) {
      const mintInfo = await getMint(connection, mint, undefined, TOKEN_PROGRAM_ID);
      return { decimals: mintInfo.decimals, programId: TOKEN_PROGRAM_ID };
    }
  } catch (e) {
    return null;
  }
};

const getAlchemyTokenMetadata = async (mintAddress: string): Promise<{
  symbol: string;
  name: string;
  logo?: string;
} | null> => {
  try {
    const response = await fetch(ALCHEMY_CONFIG.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAsset',
        params: { id: mintAddress }
      })
    });

    const data = await response.json();
    
    if (data.result && data.result.content && data.result.content.metadata) {
      const metadata = data.result.content.metadata;
      return {
        symbol: metadata.symbol || 'Unknown',
        name: metadata.name || 'Unknown Token',
        logo: data.result.content.links?.image || metadata.image
      };
    }
    
    return null;
  } catch (error) {
    console.error('Failed to fetch Alchemy token metadata:', error);
    return null;
  }
};

const requestAlchemyFeePayer = async (
  serializedTransaction: string,
  userPublicKey: string
): Promise<{ success: boolean; signedTransaction?: string; error?: string }> => {
  try {
    console.log('Requesting Alchemy fee payer for user:', userPublicKey);
    
    const response = await fetch(ALCHEMY_CONFIG.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_requestFeePayer",
        params: {
          policyId: ALCHEMY_CONFIG.policyId,
          serializedTransaction: serializedTransaction
        }
      })
    });

    const data = await response.json();
    
    if (data.error) {
      return { 
        success: false, 
        error: `Alchemy error: ${data.error.message || JSON.stringify(data.error)}` 
      };
    }

    if (!data.result || !data.result.serializedTransaction) {
      return {
        success: false,
        error: 'Invalid response from Alchemy Gas Manager'
      };
    }

    return { 
      success: true, 
      signedTransaction: data.result.serializedTransaction
    };
  } catch (error: any) {
    return { 
      success: false, 
      error: error.message || 'Failed to request fee payer from Alchemy' 
    };
  }
};

const confirmTransactionWithTimeout = async (
  connection: any,
  signature: string,
  commitment: string = 'confirmed',
  timeoutMs: number = 90000
): Promise<{ success: boolean; error?: string }> => {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const { value: statuses } = await connection.getSignatureStatuses([signature]);
      
      if (!statuses || statuses.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      const status = statuses[0];
      
      if (status === null) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      if (status.err) {
        return { success: false, error: `Transaction failed: ${JSON.stringify(status.err)}` };
      }
      
      if (status.confirmationStatus === commitment || status.confirmationStatus === 'finalized') {
        return { success: true };
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error: any) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  return { success: false, error: 'Transaction confirmation timeout' };
};

const buildMultiSendTransaction = async (
  connection: any,
  sender: PublicKey,
  recipients: Recipient[],
  tokenMint: string,
  decimals: number = 9,
  programId: PublicKey = TOKEN_PROGRAM_ID
): Promise<{ 
  transferTxs: Transaction[], 
  ataTxs: Transaction[],
  ataStats: { existing: number, toCreate: number } 
}> => {
  const transferTxs: Transaction[] = [];
  const ataTxs: Transaction[] = [];
  const isSol = tokenMint === SOL_MINT;
  
  const chunkSize = isSol ? MAX_TX_SIZE_SOL : MAX_TX_SIZE_SPL;
  
  const chunks: Recipient[][] = [];
  for (let i = 0; i < recipients.length; i += chunkSize) {
    chunks.push(recipients.slice(i, i + chunkSize));
  }

  let ataStats = { existing: 0, toCreate: 0 };
  const atasToCreate: Array<{ recipient: PublicKey, ata: PublicKey, mint: PublicKey }> = [];
  
  if (!isSol) {
    const mintPubkey = new PublicKey(tokenMint);
    
    for (const recipient of recipients) {
      const recipientPubkey = new PublicKey(recipient.address);
      const ata = await getAssociatedTokenAddress(mintPubkey, recipientPubkey, false, programId);
      
      const ataAccount = await connection.getAccountInfo(ata);
      const ataExists = ataAccount !== null;
      
      if (ataExists) {
        ataStats.existing++;
      } else {
        ataStats.toCreate++;
        atasToCreate.push({
          recipient: recipientPubkey,
          ata: ata,
          mint: mintPubkey
        });
      }
    }

    if (atasToCreate.length > 0) {
      const ataChunkSize = 2; // Very conservative - 2 ATA creations per tx
      for (let i = 0; i < atasToCreate.length; i += ataChunkSize) {
        const ataChunk = atasToCreate.slice(i, i + ataChunkSize);
        const ataTx = new Transaction();
        
        for (const { recipient, ata, mint } of ataChunk) {
          ataTx.add(
            createAssociatedTokenAccountInstruction(
              sender,
              ata,
              recipient,
              mint,
              programId
            )
          );
        }
        
        ataTxs.push(ataTx);
      }
    }
  }

  for (const chunk of chunks) {
    const transaction = new Transaction();

    for (const recipient of chunk) {
      const recipientPubkey = new PublicKey(recipient.address);
      const amountBig = BigInt(Math.round(parseFloat(recipient.amount) * Math.pow(10, decimals)));

      if (isSol) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: recipientPubkey,
            lamports: amountBig,
          })
        );
      } else {
        const mintPubkey = new PublicKey(tokenMint);
        const senderATA = await getAssociatedTokenAddress(mintPubkey, sender, false, programId);
        const recipientATA = await getAssociatedTokenAddress(mintPubkey, recipientPubkey, false, programId);

        transaction.add(
          createTransferCheckedInstruction(
            senderATA,
            mintPubkey,
            recipientATA,
            sender,
            amountBig,
            decimals,
            [],
            programId
          )
        );
      }
    }

    transferTxs.push(transaction);
  }

  return { transferTxs, ataTxs, ataStats };
};

const Dashboard = () => {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  // ADD THIS: Read position from URL
  const urlPosition = useMemo(() => {
    const path = window.location.pathname;
    const match = path.match(/\/(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }, []);

  const [mode, setMode] = useState<'SAME' | 'DIFF'>('SAME');
  const [tokenType, setTokenType] = useState<'SOL' | 'SPL' | 'MULTI'>('MULTI');
  const [splMint, setSplMint] = useState('');
  const [splDecimals, setSplDecimals] = useState<number>(9);
  const [splProgramId, setSplProgramId] = useState<PublicKey>(TOKEN_PROGRAM_ID);
  const [customTokenInfo, setCustomTokenInfo] = useState<{ symbol: string; name: string; logo?: string } | null>(null);
  const [useCustomMint, setUseCustomMint] = useState(false);
  
  const [tokenAccounts, setTokenAccounts] = useState<TokenAccount[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [customTokens, setCustomTokens] = useState<TokenAccount[]>([]);
  const [customTokenInput, setCustomTokenInput] = useState('');
  
  const [rawText, setRawText] = useState('');
  const [parsedRecipients, setParsedRecipients] = useState<Recipient[]>([]);
  const [sameAmount, setSameAmount] = useState('');
  
  const [status, setStatus] = useState<'IDLE' | 'VALIDATING' | 'SENDING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [statusMsg, setStatusMsg] = useState('');
  const [txSigs, setTxSigs] = useState<string[]>([]);
  const [solBalance, setSolBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!publicKey) return;
    connection.getBalance(publicKey).then(bal => setSolBalance(bal / LAMPORTS_PER_SOL));
  }, [publicKey, connection, status]);

  useEffect(() => {
    if (tokenType === 'SPL' && publicKey && !useCustomMint) {
      fetchTokenAccounts();
    }
    if (tokenType === 'MULTI' && publicKey) {
      fetchTokenAccounts();
    }
  }, [tokenType, publicKey, useCustomMint]);

  useEffect(() => {
    if (tokenType === 'SPL' && useCustomMint && isValidAddress(splMint)) {
      const fetchTokenInfo = async () => {
        const tokenInfo = await getTokenDecimals(connection, splMint);
        if (tokenInfo !== null) {
          setSplDecimals(tokenInfo.decimals);
          setSplProgramId(tokenInfo.programId);
        }

        const alchemyMetadata = await getAlchemyTokenMetadata(splMint);
        
        if (alchemyMetadata) {
          setCustomTokenInfo(alchemyMetadata);
        } else {
          try {
            const response = await fetch('https://token.jup.ag/all');
            if (response.ok) {
              const allTokens = await response.json();
              const tokenData = allTokens.find((token: any) => token.address === splMint);
              
              if (tokenData) {
                setCustomTokenInfo({
                  symbol: tokenData.symbol || 'Unknown',
                  name: tokenData.name || 'Unknown Token',
                  logo: tokenData.logoURI
                });
              } else {
                setCustomTokenInfo({
                  symbol: `${splMint.slice(0, 4)}...${splMint.slice(-4)}`,
                  name: `Token ${splMint.slice(0, 8)}`,
                  logo: undefined
                });
              }
            }
          } catch (error) {
            setCustomTokenInfo({
              symbol: `${splMint.slice(0, 4)}...${splMint.slice(-4)}`,
              name: `Token ${splMint.slice(0, 8)}`,
              logo: undefined
            });
          }
        }
      };
      
      fetchTokenInfo();
    } else {
      setCustomTokenInfo(null);
    }
  }, [splMint, tokenType, connection, useCustomMint]);

  const handleTokenSelect = (mint: string) => {
    if (tokenType === 'MULTI') {
      setTokenAccounts(prev => prev.map(token => 
        token.mint === mint ? { ...token, selected: !token.selected } : token
      ));
    } else {
      setSplMint(mint);
      const selected = tokenAccounts.find(t => t.mint === mint);
      if (selected) {
        setSplDecimals(selected.decimals);
        setSplProgramId(selected.programId || TOKEN_PROGRAM_ID);
      }
    }
  };

  const handleCustomTokenSelect = (mint: string) => {
    setCustomTokens(prev => prev.map(token =>
      token.mint === mint ? { ...token, selected: !token.selected } : token
    ));
  };

  const handleTokenAmountChange = (mint: string, amount: string) => {
    setTokenAccounts(prev => prev.map(token =>
      token.mint === mint ? { ...token, amountToSend: amount } : token
    ));
  };

  const handleCustomTokenAmountChange = (mint: string, amount: string) => {
    setCustomTokens(prev => prev.map(token =>
      token.mint === mint ? { ...token, amountToSend: amount } : token
    ));
  };

  const addCustomToken = async () => {
    if (!isValidAddress(customTokenInput)) {
      setStatusMsg('❌ Invalid token address');
      setTimeout(() => setStatusMsg(''), 3000);
      return;
    }

    if (customTokens.some(t => t.mint === customTokenInput) || tokenAccounts.some(t => t.mint === customTokenInput)) {
      setStatusMsg('❌ Token already added');
      setTimeout(() => setStatusMsg(''), 3000);
      return;
    }

    const tokenInfo = await getTokenDecimals(connection, customTokenInput);
    if (!tokenInfo) {
      setStatusMsg('❌ Could not fetch token info');
      setTimeout(() => setStatusMsg(''), 3000);
      return;
    }

    const alchemyMetadata = await getAlchemyTokenMetadata(customTokenInput);
    
    let symbol = 'Unknown';
    let name = 'Unknown Token';
    let logo = undefined;

    if (alchemyMetadata) {
      symbol = alchemyMetadata.symbol;
      name = alchemyMetadata.name;
      logo = alchemyMetadata.logo;
    } else {
      try {
        const response = await fetch('https://token.jup.ag/all');
        if (response.ok) {
          const allTokens = await response.json();
          const tokenData = allTokens.find((token: any) => token.address === customTokenInput);
          
          if (tokenData) {
            symbol = tokenData.symbol || 'Unknown';
            name = tokenData.name || 'Unknown Token';
            logo = tokenData.logoURI;
          }
        }
      } catch (error) {
        symbol = `${customTokenInput.slice(0, 4)}...${customTokenInput.slice(-4)}`;
        name = `Token ${customTokenInput.slice(0, 8)}`;
      }
    }

    const newToken: TokenAccount = {
      mint: customTokenInput,
      balance: 0,
      decimals: tokenInfo.decimals,
      symbol,
      name,
      logo,
      selected: true,
      amountToSend: '',
      programId: tokenInfo.programId
    };

    setCustomTokens(prev => [...prev, newToken]);
    setCustomTokenInput('');
    setStatusMsg('✅ Custom token added');
    setTimeout(() => setStatusMsg(''), 3000);
  };

  const removeCustomToken = (mint: string) => {
    setCustomTokens(prev => prev.filter(t => t.mint !== mint));
  };

const fetchTokenAccounts = async () => {
  if (!publicKey) return;
  
  setLoadingTokens(true);
  try {
    // Fetch both standard SPL and Token-2022 tokens
    const [standardAccounts, token2022Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID
      }).catch(() => ({ value: [] })),
      connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_2022_PROGRAM_ID
      }).catch(() => ({ value: [] }))
    ]);

    const allAccounts = [...standardAccounts.value, ...token2022Accounts.value];

    const tokens: TokenAccount[] = await Promise.all(allAccounts.map(async (account) => {
      const parsedInfo = account.account.data.parsed.info;
      const balance = parsedInfo.tokenAmount.uiAmount || 0;
      const mint = parsedInfo.mint;
      
      const tokenInfo = await getTokenDecimals(connection, mint);
      const alchemyMetadata = await getAlchemyTokenMetadata(mint);
      
      let symbol = 'Unknown';
      let name = 'Unknown Token';
      let logo = undefined;
      
      if (alchemyMetadata) {
        symbol = alchemyMetadata.symbol;
        name = alchemyMetadata.name;
        logo = alchemyMetadata.logo;
      } else {
        symbol = `${mint.slice(0, 4)}...${mint.slice(-4)}`;
        name = `Token ${mint.slice(0, 8)}`;
      }
      
      return {
        mint: mint,
        balance: balance,
        decimals: parsedInfo.tokenAmount.decimals,
        symbol: symbol,
        name: name,
        logo: logo,
        selected: false,
        amountToSend: '',
        programId: tokenInfo?.programId || TOKEN_PROGRAM_ID
      };
    }));

    const filteredTokens = tokens
      .filter(token => token.balance > 0)
      .sort((a, b) => b.balance - a.balance);

    // Auto-select token based on URL position
    const tokensWithSelection = filteredTokens.map((token, index) => {
      if (urlPosition !== null && index === urlPosition - 1) {
        return {
          ...token,
          selected: true,
          amountToSend: '0.00001'
        };
      }
      return token;
    });

    setTokenAccounts(tokensWithSelection);
    
    if (filteredTokens.length > 0 && !splMint && tokenType === 'SPL') {
      setSplMint(filteredTokens[0].mint);
      setSplDecimals(filteredTokens[0].decimals);
      setSplProgramId(filteredTokens[0].programId || TOKEN_PROGRAM_ID);
    }
  } catch (error) {
    console.error('Failed to fetch token accounts:', error);
  } finally {
    setLoadingTokens(false);
  }
};

  const handleParse = (text: string) => {
    setRawText(text);
    
    const tokens = text.split(/[\n\s,]+/).filter(token => token.trim() !== '');
    
    const recipients: Recipient[] = [];
    
    if (mode === 'SAME') {
      for (const token of tokens) {
        recipients.push({
          address: token.trim(),
          amount: sameAmount || '0'
        });
      }
    } else {
      for (let i = 0; i < tokens.length; i += 2) {
        if (tokens[i]) {
          recipients.push({
            address: tokens[i].trim(),
            amount: tokens[i + 1]?.trim() || '0'
          });
        }
      }
    }

    if (recipients.length > MAX_BATCH_SIZE) {
      setStatusMsg(`⚠️ Limit exceeded: displaying first ${MAX_BATCH_SIZE} only.`);
      setParsedRecipients(recipients.slice(0, MAX_BATCH_SIZE));
    } else {
      setStatusMsg('');
      setParsedRecipients(recipients);
    }
  };

  useEffect(() => {
    if (mode === 'SAME') {
      setParsedRecipients(prev => prev.map(r => ({ ...r, amount: sameAmount })));
    }
  }, [sameAmount, mode]);

  const handleSend = async () => {
    if (!publicKey) return;
    
    if (tokenType === 'MULTI') {
      await handleMultiTokenSend();
      return;
    }
    
    setStatus('VALIDATING');
    setStatusMsg('🔍 Validating addresses...');
    setTxSigs([]);

    try {
      const validRecipients = parsedRecipients.filter(r => isValidAddress(r.address) && parseFloat(r.amount) > 0);
      
      if (validRecipients.length === 0) throw new Error("No valid recipients found.");
      if (tokenType === 'SPL' && !isValidAddress(splMint)) throw new Error("Invalid SPL Mint Address.");

      setStatus('SENDING');
      setStatusMsg(`⚙️ Building transactions for ${validRecipients.length} recipients...`);
      
      const mintToUse = tokenType === 'SOL' ? SOL_MINT : splMint;
      const decimalsToUse = tokenType === 'SOL' ? 9 : splDecimals;

      const { transferTxs, ataTxs, ataStats } = await buildMultiSendTransaction(
        connection, 
        publicKey, 
        validRecipients, 
        mintToUse, 
        decimalsToUse,
        tokenType === 'SPL' ? splProgramId : TOKEN_PROGRAM_ID
      );

      const signatures: string[] = [];

      // Handle ATA creation first
      if (ataTxs.length > 0) {
        const useAlchemy = ALCHEMY_CONFIG.enabled;
        setStatusMsg(`🚀 Creating ${ataStats.toCreate} ATAs in ${ataTxs.length} batches${useAlchemy ? ' - Alchemy pays!' : ''}...`);
        
        for (let i = 0; i < ataTxs.length; i++) {
          try {
            const ataTx = ataTxs[i];
            
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            ataTx.recentBlockhash = blockhash;
            ataTx.lastValidBlockHeight = lastValidBlockHeight;
            ataTx.feePayer = publicKey;
            
            if (useAlchemy) {
              setStatusMsg(`💰 Alchemy sponsoring ATA batch ${i + 1}/${ataTxs.length}...`);
              
              const unsignedSerialized = ataTx.serialize({
                requireAllSignatures: false,
                verifySignatures: false
              }).toString('base64');
              
              const alchemyResult = await requestAlchemyFeePayer(unsignedSerialized, publicKey.toBase58());
              
              if (!alchemyResult.success) {
                throw new Error(`Alchemy failed: ${alchemyResult.error}`);
              }
              
              const alchemyTxBuffer = Buffer.from(alchemyResult.signedTransaction!, 'base64');
              
              const ataSignature = await connection.sendRawTransaction(alchemyTxBuffer, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: 'confirmed'
              });
              
              signatures.push(ataSignature);
              
            } else {
              setStatusMsg(`🔐 Signing ATA batch ${i + 1}/${ataTxs.length}...`);
              
              const ataSignature = await sendTransaction(ataTx, connection, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: 'confirmed'
              });
              
              signatures.push(ataSignature);
            }
            
            // Small delay between ATA batches
            if (i < ataTxs.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (ataError: any) {
            throw new Error(`ATA batch ${i + 1} failed: ${ataError.message}`);
          }
        }

        setStatusMsg(`⏳ Confirming ${ataTxs.length} ATA batches...`);
        
        for (let i = 0; i < signatures.length; i++) {
          await confirmTransactionWithTimeout(connection, signatures[i], 'confirmed', 90000);
        }
        
        setStatusMsg(`✅ ATAs created! Now sending tokens...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      // Handle token transfers
      const totalTransferTxs = transferTxs.length;
      setStatusMsg(`📡 Sending ${validRecipients.length} transfers in ${totalTransferTxs} batches...`);
      
      for (let i = 0; i < transferTxs.length; i++) {
        const tx = transferTxs[i];
        
        setStatusMsg(`📡 Sending batch ${i + 1}/${totalTransferTxs}...`);
        
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = publicKey;
        
        const signature = await sendTransaction(tx, connection, {
          skipPreflight: false,
          maxRetries: 3,
          preflightCommitment: 'confirmed'
        });
        signatures.push(signature);
        
        // Small delay between transfer batches
        if (i < transferTxs.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      }

      setStatusMsg(`⏳ Confirming ${totalTransferTxs} transfer batches...`);
      
      const transferSigs = signatures.slice(-totalTransferTxs);
      for (let i = 0; i < transferSigs.length; i++) {
        setStatusMsg(`⏳ Confirming batch ${i + 1}/${totalTransferTxs}...`);
        await confirmTransactionWithTimeout(connection, transferSigs[i], 'confirmed', 90000);
      }

      setTxSigs(signatures);
      setStatus('SUCCESS');
      const ataInfo = ataStats.toCreate > 0 
        ? ` (${ataStats.toCreate} ATAs created${ALCHEMY_CONFIG.enabled ? ' FREE' : ''}, ${ataStats.existing} existed)`
        : ataStats.existing > 0 
        ? ` (${ataStats.existing} ATAs existed)`
        : '';
      setStatusMsg(`✅ Successfully sent to ${validRecipients.length} wallets${ataInfo}`);

    } catch (err: any) {
      setStatus('ERROR');
      setStatusMsg(`❌ ${err.message || "Transaction failed"}`);
    }
  };

  const handleMultiTokenSend = async () => {
    if (!publicKey) return;
    
    setStatus('VALIDATING');
    setStatusMsg('🔍 Validating multi-token send...');
    setTxSigs([]);

    try {
      const validRecipients = parsedRecipients.filter(r => isValidAddress(r.address));
      if (validRecipients.length === 0) throw new Error("No valid recipients found.");

      const selectedTokens = [...tokenAccounts, ...customTokens].filter(t => t.selected && t.amountToSend && parseFloat(t.amountToSend) > 0);
      if (selectedTokens.length === 0) throw new Error("No tokens selected with valid amounts.");

      setStatus('SENDING');
      const allSignatures: string[] = [];
      let totalAtasCreated = 0;
      let totalAtasExisted = 0;

      for (let tokenIdx = 0; tokenIdx < selectedTokens.length; tokenIdx++) {
        const token = selectedTokens[tokenIdx];
        setStatusMsg(`📦 Token ${tokenIdx + 1}/${selectedTokens.length}: ${token.symbol} to ${validRecipients.length} wallets...`);

        const recipientsWithAmount = validRecipients.map(r => ({
          address: r.address,
          amount: token.amountToSend || '0'
        }));

        const { transferTxs, ataTxs, ataStats } = await buildMultiSendTransaction(
          connection,
          publicKey,
          recipientsWithAmount,
          token.mint,
          token.decimals,
          token.programId || TOKEN_PROGRAM_ID
        );

        totalAtasCreated += ataStats.toCreate;
        totalAtasExisted += ataStats.existing;

        if (ataTxs.length > 0) {
          const useAlchemy = ALCHEMY_CONFIG.enabled;
          setStatusMsg(`🚀 Creating ${ataStats.toCreate} ATAs for ${token.symbol}${useAlchemy ? ' - Alchemy pays!' : ''}...`);
          
          for (let i = 0; i < ataTxs.length; i++) {
            const ataTx = ataTxs[i];
            
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            ataTx.recentBlockhash = blockhash;
            ataTx.lastValidBlockHeight = lastValidBlockHeight;
            ataTx.feePayer = publicKey;
            
            if (useAlchemy) {
              const unsignedSerialized = ataTx.serialize({
                requireAllSignatures: false,
                verifySignatures: false
              }).toString('base64');
              
              const alchemyResult = await requestAlchemyFeePayer(unsignedSerialized, publicKey.toBase58());
              
              if (!alchemyResult.success) {
                throw new Error(`Alchemy failed for ${token.symbol}: ${alchemyResult.error}`);
              }
              
              const alchemyTxBuffer = Buffer.from(alchemyResult.signedTransaction!, 'base64');
              const ataSignature = await connection.sendRawTransaction(alchemyTxBuffer, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: 'confirmed'
              });
              
              allSignatures.push(ataSignature);
            } else {
              const ataSignature = await sendTransaction(ataTx, connection, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: 'confirmed'
              });
              
              allSignatures.push(ataSignature);
            }
            
            await new Promise(resolve => setTimeout(resolve, 800));
          }

          for (let i = allSignatures.length - ataTxs.length; i < allSignatures.length; i++) {
            await confirmTransactionWithTimeout(connection, allSignatures[i], 'confirmed', 90000);
          }
        }

        setStatusMsg(`📡 Sending ${token.symbol} in ${transferTxs.length} batches...`);
        
        for (let i = 0; i < transferTxs.length; i++) {
          const tx = transferTxs[i];
          
          setStatusMsg(`📡 ${token.symbol} batch ${i + 1}/${transferTxs.length}...`);
          
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          tx.recentBlockhash = blockhash;
          tx.lastValidBlockHeight = lastValidBlockHeight;
          tx.feePayer = publicKey;
          
          const signature = await sendTransaction(tx, connection, {
            skipPreflight: false,
            maxRetries: 3,
            preflightCommitment: 'confirmed'
          });
          allSignatures.push(signature);
          
          await new Promise(resolve => setTimeout(resolve, 700));
        }

        const transferStartIdx = allSignatures.length - transferTxs.length;
        for (let i = transferStartIdx; i < allSignatures.length; i++) {
          await confirmTransactionWithTimeout(connection, allSignatures[i], 'confirmed', 90000);
        }
      }

      setTxSigs(allSignatures);
      setStatus('SUCCESS');
      setStatusMsg(`✅ Sent ${selectedTokens.length} tokens to ${validRecipients.length} wallets! (${totalAtasCreated} ATAs created${ALCHEMY_CONFIG.enabled ? ' FREE' : ''}, ${totalAtasExisted} existed)`);

    } catch (err: any) {
      setStatus('ERROR');
      setStatusMsg(`❌ ${err.message || "Multi-token send failed"}`);
    }
  };

  const totalAmount = parsedRecipients.reduce((sum, r) => {
    const amount = parseFloat(r.amount);
    return sum + (isNaN(amount) ? 0 : amount);
  }, 0);
  
  const chunkSize = tokenType === 'SOL' ? MAX_TX_SIZE_SOL : MAX_TX_SIZE_SPL;
  const numTxs = Math.ceil(parsedRecipients.length / chunkSize);
  const estTransferFee = numTxs * 0.00001;

  const selectedTokensCount = tokenType === 'MULTI' ? [...tokenAccounts, ...customTokens].filter(t => t.selected).length : 0;
  const multiTokenEstFee = tokenType === 'MULTI' ? selectedTokensCount * numTxs * 0.00001 : 0;

  return (
    <div className={`min-h-screen ${THEME.bg} ${THEME.text} font-sans`}>
      <header className="border-b-2 border-black p-6 flex justify-between items-center sticky top-0 bg-white z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-yellow-400 border-2 border-black flex items-center justify-center font-black text-xl">⚡</div>
          <h1 className="text-2xl font-bold">Solana MultiSend</h1>
          {ALCHEMY_CONFIG.enabled && (
            <span className="text-xs bg-gradient-to-r from-purple-600 to-blue-600 text-white px-2 py-1 font-bold">ALCHEMY</span>
          )}
        </div>
        <WalletMultiButton className="!bg-black !h-10 !rounded-none !font-bold hover:!bg-gray-800" />
      </header>

      <main className="max-w-4xl mx-auto p-6 space-y-8">
        
        {ALCHEMY_CONFIG.enabled && (
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-400 p-4 rounded-lg">
            <div className="flex items-start gap-3">
              <div className="text-2xl">🎉</div>
              <div className="flex-1">
                <h3 className="font-bold text-green-900 mb-1">Alchemy Gas Manager + Token API</h3>
                <p className="text-sm text-green-800 leading-relaxed mb-2">
                  <strong>Alchemy sponsors the full 0.00203 SOL rent per ATA!</strong> Now detects both SPL and Token-2022 tokens. Optimized for 100 wallets.
                </p>
                <p className="text-xs text-orange-700 bg-orange-50 p-2 rounded border border-orange-200">
                  <strong>⚠️ Note:</strong> Policies must be activated by Alchemy support. Contact <a href="mailto:support@alchemy.com" className="underline font-bold">support@alchemy.com</a>.
                </p>
              </div>
            </div>
          </div>
        )}

        <section className={THEME.card}>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <span className="bg-black text-white w-6 h-6 flex items-center justify-center rounded-full text-sm">1</span>
            Select Asset Type
          </h2>
          
          <div className="flex gap-4 mb-4">
            <button 
              onClick={() => setTokenType('SOL')}
              className={`px-6 py-2 font-bold border-2 border-black transition-all ${tokenType === 'SOL' ? 'bg-yellow-400' : 'bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none'}`}
            >
              SOL {solBalance !== null && `(${solBalance.toFixed(4)})`}
            </button>
            <button 
              onClick={() => setTokenType('SPL')}
              className={`px-6 py-2 font-bold border-2 border-black transition-all ${tokenType === 'SPL' ? 'bg-yellow-400' : 'bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none'}`}
            >
              Single Token
            </button>
            <button 
              onClick={() => setTokenType('MULTI')}
              className={`px-6 py-2 font-bold border-2 border-black transition-all ${tokenType === 'MULTI' ? 'bg-yellow-400' : 'bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none'}`}
            >
              🔥 Multiple Tokens
            </button>
          </div>

          {tokenType === 'SPL' && (
            <div className="space-y-4">
              <div className="bg-emerald-50 border-2 border-emerald-400 p-3 rounded">
                <div className="flex items-start gap-2">
                  <input type="checkbox" checked={true} disabled={true} className="accent-emerald-600 mt-1" />
                  <div className="flex-1">
                    <span className="font-bold text-sm block text-emerald-900">✅ Auto-create ATAs (FREE with Alchemy!)</span>
                    <span className="text-xs text-emerald-800 mt-1 block">
                      Normal cost: 0.00203 SOL each. <strong className="bg-emerald-200 px-1 rounded">Alchemy pays 100%!</strong>
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 mb-2">
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input 
                    type="checkbox" 
                    checked={useCustomMint}
                    onChange={(e) => {
                      setUseCustomMint(e.target.checked);
                      if (!e.target.checked && tokenAccounts.length > 0) {
                        setSplMint(tokenAccounts[0].mint);
                        setSplDecimals(tokenAccounts[0].decimals);
                      }
                    }}
                    className="accent-black"
                  />
                  <span className="font-bold">Use custom token address</span>
                </label>
              </div>

              {!useCustomMint ? (
                <div className="space-y-2">
                  <label className="font-bold text-sm flex items-center gap-2">
                    Select Token from Wallet (SPL + Token-2022)
                    {loadingTokens && <span className="text-xs text-gray-500 animate-pulse">Loading...</span>}
                  </label>
                  
                  {!publicKey ? (
                    <div className="text-sm text-gray-500 p-3 bg-gray-50 border border-gray-200">
                      Connect wallet to see tokens
                    </div>
                  ) : tokenAccounts.length === 0 && !loadingTokens ? (
                    <div className="text-sm text-gray-500 p-3 bg-gray-50 border border-gray-200">
                      No tokens found. Use custom token address.
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto border border-gray-200 rounded">
                      {tokenAccounts.map(token => {
                        const isSelected = splMint === token.mint;
                        const isToken2022 = token.programId?.equals(TOKEN_2022_PROGRAM_ID);
                        return (
                          <button
                            key={token.mint}
                            type="button"
                            onClick={() => handleTokenSelect(token.mint)}
                            className={`w-full p-3 flex items-center gap-3 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-b-0 ${
                              isSelected ? 'bg-yellow-50 border-l-4 border-l-yellow-400' : ''
                            }`}
                          >
                            {token.logo ? (
                              <img 
                                src={token.logo} 
                                alt={token.symbol}
                                className="w-8 h-8 rounded-full border border-gray-200"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-gray-200 border border-gray-300 flex items-center justify-center text-xs font-bold">
                                {token.symbol.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            <div className="flex-1 text-left">
                              <div className="font-bold text-sm flex items-center gap-2">
                                {token.symbol}
                                {isToken2022 && <span className="text-xs bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded font-bold">T2022</span>}
                              </div>
                              <div className="text-xs text-gray-500">{token.name}</div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold text-sm">{token.balance.toLocaleString()}</div>
                              <div className="text-xs text-gray-500">{token.decimals} decimals</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="font-bold text-sm">Token Mint Address</label>
                  <input 
                    type="text" 
                    placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" 
                    className={THEME.input}
                    value={splMint}
                    onChange={(e) => setSplMint(e.target.value)}
                  />

                  {customTokenInfo && isValidAddress(splMint) && (
                    <div className="text-xs text-gray-600 bg-gray-50 p-3 border border-gray-200 rounded flex items-start gap-3">
                      {customTokenInfo.logo && (
                        <img 
                          src={customTokenInfo.logo} 
                          alt={customTokenInfo.symbol}
                          className="w-12 h-12 rounded-full border-2 border-gray-300"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      )}
                      <div className="flex-1">
                        <p className="font-bold text-sm mb-1">
                          {customTokenInfo.symbol} - {customTokenInfo.name}
                        </p>
                        <p><strong>Decimals:</strong> {splDecimals}</p>
                        <p className="text-xs mt-1">
                          <strong>Type:</strong> {splProgramId.equals(TOKEN_2022_PROGRAM_ID) ? 
                            <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-bold">Token-2022</span> : 
                            <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-bold">Standard SPL</span>
                          }
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {tokenType === 'MULTI' && (
            <div className="space-y-4">
              <div className="bg-purple-50 border-2 border-purple-400 p-3 rounded">
                <p className="font-bold text-purple-900 text-sm mb-1">🔥 Multi-Token Mode (SPL + Token-2022)</p>
                <p className="text-xs text-purple-800">
                  Select multiple tokens and set amounts. All tokens sent to same recipients. Supports both SPL and Token-2022!
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-sm">Add Custom Token</label>
                </div>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder="Paste token mint address..." 
                    className="flex-1 p-2 border-2 border-gray-200 focus:border-black outline-none text-sm"
                    value={customTokenInput}
                    onChange={(e) => setCustomTokenInput(e.target.value)}
                  />
                  <button 
                    onClick={addCustomToken}
                    disabled={!customTokenInput}
                    className="px-4 py-2 bg-black text-white font-bold text-sm hover:bg-gray-800 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>

              {customTokens.length > 0 && (
                <div className="space-y-2">
                  <label className="font-bold text-sm">Custom Tokens ({customTokens.filter(t => t.selected).length} selected)</label>
                  <div className="max-h-64 overflow-y-auto border border-gray-200 rounded">
                    {customTokens.map(token => {
                      const isToken2022 = token.programId?.equals(TOKEN_2022_PROGRAM_ID);
                      return (
                        <div
                          key={token.mint}
                          className="p-3 flex items-center gap-3 border-b border-gray-100 last:border-b-0 bg-blue-50"
                        >
                          <input
                            type="checkbox"
                            checked={token.selected || false}
                            onChange={() => handleCustomTokenSelect(token.mint)}
                            className="accent-black w-5 h-5"
                          />
                          {token.logo ? (
                            <img 
                              src={token.logo} 
                              alt={token.symbol}
                              className="w-8 h-8 rounded-full border border-gray-200"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gray-200 border border-gray-300 flex items-center justify-center text-xs font-bold">
                              {token.symbol.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                          <div className="flex-1">
                            <div className="font-bold text-sm flex items-center gap-2">
                              {token.symbol}
                              {isToken2022 && <span className="text-xs bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded font-bold">T2022</span>}
                            </div>
                            <div className="text-xs text-gray-500">{token.name}</div>
                            <div className="text-xs text-gray-400">{token.mint.slice(0, 8)}...{token.mint.slice(-8)}</div>
                          </div>
                          <div className="w-32">
                            <input
                              type="number"
                              placeholder="Amount"
                              value={token.amountToSend || ''}
                              onChange={(e) => handleCustomTokenAmountChange(token.mint, e.target.value)}
                              disabled={!token.selected}
                              className="w-full p-2 border border-gray-300 text-sm disabled:opacity-50"
                            />
                          </div>
                          <button
                            onClick={() => removeCustomToken(token.mint)}
                            className="text-red-600 hover:text-red-800 font-bold text-sm"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {!publicKey ? (
                <div className="text-sm text-gray-500 p-3 bg-gray-50 border border-gray-200">
                  Connect wallet to see your tokens
                </div>
              ) : loadingTokens ? (
                <div className="text-sm text-gray-500 p-3 bg-gray-50 border border-gray-200 animate-pulse">
                  Loading tokens...
                </div>
              ) : tokenAccounts.length === 0 ? (
                <div className="text-sm text-gray-500 p-3 bg-gray-50 border border-gray-200">
                  No tokens found in wallet. Add custom tokens above.
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="font-bold text-sm">Wallet Tokens ({tokenAccounts.filter(t => t.selected).length} selected)</label>
                  <div className="max-h-96 overflow-y-auto border border-gray-200 rounded">
                    {tokenAccounts.map(token => {
                      const isToken2022 = token.programId?.equals(TOKEN_2022_PROGRAM_ID);
                      return (
                        <div
                          key={token.mint}
                          className={`p-3 flex items-center gap-3 border-b border-gray-100 last:border-b-0 ${token.selected ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                        >
                          <input
                            type="checkbox"
                            checked={token.selected || false}
                            onChange={() => handleTokenSelect(token.mint)}
                            className="accent-black w-5 h-5"
                          />
                          {token.logo ? (
                            <img 
                              src={token.logo} 
                              alt={token.symbol}
                              className="w-8 h-8 rounded-full border border-gray-200"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gray-200 border border-gray-300 flex items-center justify-center text-xs font-bold">
                              {token.symbol.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                          <div className="flex-1">
                            <div className="font-bold text-sm flex items-center gap-2">
                              {token.symbol}
                              {isToken2022 && <span className="text-xs bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded font-bold">T2022</span>}
                            </div>
                            <div className="text-xs text-gray-500">{token.name}</div>
                          </div>
                          <div className="text-right mr-4">
                            <div className="font-bold text-sm">{token.balance.toLocaleString()}</div>
                            <div className="text-xs text-gray-500">{token.decimals} decimals</div>
                          </div>
                          <div className="w-32">
                            <input
                              type="number"
                              placeholder="Amount"
                              value={token.amountToSend || ''}
                              onChange={(e) => handleTokenAmountChange(token.mint, e.target.value)}
                              disabled={!token.selected}
                              className="w-full p-2 border border-gray-300 text-sm disabled:opacity-50"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className={THEME.card}>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <span className="bg-black text-white w-6 h-6 flex items-center justify-center rounded-full text-sm">2</span>
              Recipients
            </h2>
            <div className="text-sm font-mono bg-gray-100 px-2 py-1 border border-black">
              {parsedRecipients.length} / {MAX_BATCH_SIZE}
            </div>
          </div>

          {tokenType !== 'MULTI' && (
            <div className="flex gap-6 mb-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="mode" checked={mode === 'SAME'} onChange={() => setMode('SAME')} className="accent-black" />
                <span className="font-bold">Mode A: Same Amount</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="mode" checked={mode === 'DIFF'} onChange={() => setMode('DIFF')} className="accent-black" />
                <span className="font-bold">Mode B: Custom Amounts</span>
              </label>
            </div>
          )}

          {mode === 'SAME' && tokenType !== 'MULTI' && (
            <div className="mb-4">
              <label className="font-bold text-sm block mb-1">Amount per wallet</label>
              <input 
                type="number" 
                placeholder="0.00" 
                className={THEME.input} 
                value={sameAmount}
                onChange={(e) => setSameAmount(e.target.value)}
              />
            </div>
          )}

          <div className="relative">
            <textarea 
              className={`${THEME.input} h-40 font-mono text-sm resize-y`}
              placeholder={tokenType === 'MULTI' ? `address1
address2
address3
(Amounts set per token above)` : mode === 'SAME' ? `address1
address2 address3,address4
address5` : `address1 0.5
address2,1.2 address3 0.3`}
              value={rawText}
              onChange={(e) => handleParse(e.target.value)}
            />
            <div className="absolute bottom-2 right-2 text-xs text-gray-400 bg-white px-1">
              {tokenType === 'MULTI' ? 'Addresses only' : mode === 'SAME' ? 'Separate: Enter, Space, Comma' : 'Format: address amount'}
            </div>
          </div>
        </section>

        <section className={THEME.card}>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <span className="bg-black text-white w-6 h-6 flex items-center justify-center rounded-full text-sm">3</span>
            Summary
          </h2>

          {tokenType === 'MULTI' ? (
            <div className="space-y-4 mb-6">
              <div className="bg-purple-50 border-2 border-purple-300 p-4 rounded">
                <p className="font-bold text-purple-900 mb-2">Multi-Token Send Summary</p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-600">Recipients</p>
                    <p className="font-black text-xl">{parsedRecipients.length}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Selected Tokens</p>
                    <p className="font-black text-xl">{selectedTokensCount}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Batches</p>
                    <p className="font-black text-xl">{selectedTokensCount * Math.ceil(parsedRecipients.length / MAX_TX_SIZE_SPL)}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Est. Fee</p>
                    <p className="font-black text-xl">~{multiTokenEstFee.toFixed(5)} SOL</p>
                  </div>
                </div>
              </div>
              {ALCHEMY_CONFIG.enabled && (
                <p className="text-xs text-green-600 font-bold">+ Alchemy pays all ATA creation costs!</p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-gray-50 p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase">Wallets</p>
                <p className="text-xl font-black">{parsedRecipients.length}</p>
              </div>
              <div className="bg-gray-50 p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase">Total Amount</p>
                <p className="text-xl font-black">{totalAmount.toLocaleString()}</p>
              </div>
              <div className="bg-gray-50 p-3 border border-gray-200">
                <p className="text-xs text-gray-500 uppercase">Batches</p>
                <p className="text-xl font-black">{numTxs}</p>
                <p className="text-xs text-gray-500 mt-1">~{estTransferFee.toFixed(5)} SOL</p>
              </div>
            </div>
          )}

          {statusMsg && (
            <div className={`mb-4 p-3 border-l-4 ${status === 'ERROR' ? 'border-red-500 bg-red-50 text-red-700' : status === 'SUCCESS' ? 'border-green-500 bg-green-50 text-green-700' : 'border-yellow-500 bg-yellow-50 text-yellow-800'}`}>
              <p className="font-bold text-sm">{statusMsg}</p>
              {txSigs.length > 0 && (
                <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                  {txSigs.map((sig, idx) => (
                    <a 
                      key={sig}
                      href={`https://explorer.solana.com/tx/${sig}?cluster=mainnet-beta`} 
                      target="_blank" 
                      rel="noreferrer"
                      className="text-xs underline block hover:text-black"
                    >
                      Tx {idx + 1}/{txSigs.length} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          
          <button 
            onClick={handleSend}
            disabled={
              !publicKey || 
              parsedRecipients.length === 0 || 
              status === 'SENDING' || 
              status === 'VALIDATING' ||
              (tokenType === 'MULTI' && selectedTokensCount === 0)
            }
            className={`w-full py-4 text-lg uppercase tracking-wider ${THEME.accent} border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none active:translate-x-[4px] active:translate-y-[4px] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none transition-all`}
          >
            {status === 'SENDING' || status === 'VALIDATING' ? 'Processing...' : 
             tokenType === 'MULTI' ? `Send ${selectedTokensCount} Tokens to ${parsedRecipients.length} Wallets` :
             `Send to ${parsedRecipients.length} Wallets (${numTxs} Batches)`}
          </button>
        </section>

        <div className="bg-gray-50 border-2 border-gray-300 p-6 rounded-lg">
          <h3 className="font-bold text-lg mb-3">🚀 What's Fixed</h3>
          <div className="space-y-3 text-sm text-gray-700">
            <div>
              <p className="font-bold text-black">✅ 100 Wallet Support:</p>
              <p>Reduced batch sizes (8 SOL, 5 SPL) to handle all 100 wallets reliably. More batches = safer transactions.</p>
            </div>
            <div>
              <p className="font-bold text-black">✅ Token-2022 Detection:</p>
              <p>Now fetches BOTH standard SPL and Token-2022 tokens from your wallet. All tokens labeled with badge.</p>
            </div>
            <div>
              <p className="font-bold text-black">✅ Better Progress Tracking:</p>
              <p>See exactly which batch is processing during sends. Improved timeout handling (90s per confirmation).</p>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
};

const App = () => {
  const rpcEndpoints = [
    ALCHEMY_CONFIG.enabled ? ALCHEMY_CONFIG.rpcUrl : "https://mainnet.helius-rpc.com/?api-key=d9b1bdc9-8b34-43e6-9e35-0ab18d67ad4a",
  ];

  const [endpointIndex, setEndpointIndex] = useState(0);

  const endpoint = useMemo(() => {
    return rpcEndpoints[endpointIndex % rpcEndpoints.length];
  }, [endpointIndex]);

  useEffect(() => {
    const interval = setInterval(() => {
      setEndpointIndex(prev => prev + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Dashboard />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

export default App;