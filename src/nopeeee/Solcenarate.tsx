import { useState } from 'react';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createCloseAccountInstruction,
  createBurnInstruction,
} from '@solana/spl-token';
import { PRIVATE_KEYS } from './privateKeys';

const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=d9b1bdc9-8b34-43e6-9e35-0ab18d67ad4a';
const PARALLEL_WALLETS = 3;
const BATCH_SIZE = 5; // Close 5 accounts per transaction

const THEME = {
  bg: "bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900",
  text: "text-white",
  accent: "bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white font-bold",
  card: "p-6 border-2 border-pink-500 shadow-[4px_4px_0px_0px_rgba(236,72,153,1)] bg-gray-900",
};

interface TokenAccount {
  address: PublicKey;
  mint: string;
  balance: number;
  decimals: number;
  programId: PublicKey;
}

interface ProcessResult {
  wallet: string;
  status: 'success' | 'error' | 'no_accounts';
  accountsClosed: number;
  solReclaimed: number;
  message: string;
  signatures: string[];
  timeMs: number;
}

const DirectCloser = () => {
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<ProcessResult[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-50), `[${time}] ${msg}`]);
  };

  const getAllTokenAccounts = async (connection: Connection, owner: PublicKey): Promise<TokenAccount[]> => {
    const [standardRes, token2022Res] = await Promise.allSettled([
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
    ]);

    const allAccounts = [
      ...(standardRes.status === 'fulfilled' ? standardRes.value.value : []),
      ...(token2022Res.status === 'fulfilled' ? token2022Res.value.value : [])
    ];
    
    return allAccounts.map(account => {
      const info = account.account.data.parsed.info;
      const programId = account.account.owner.equals(TOKEN_2022_PROGRAM_ID) 
        ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      
      return {
        address: account.pubkey,
        mint: info.mint,
        balance: info.tokenAmount.uiAmount || 0,
        decimals: info.tokenAmount.decimals,
        programId
      };
    });
  };

  const closeAccountsBatch = async (
    connection: Connection,
    keypair: Keypair,
    accounts: TokenAccount[]
  ): Promise<{ success: number; signature: string | null }> => {
    try {
      const transaction = new Transaction();
      
      for (const account of accounts) {
        // If account has balance, burn it first
        if (account.balance > 0) {
          const amount = Math.floor(account.balance * Math.pow(10, account.decimals));
          transaction.add(
            createBurnInstruction(
              account.address,
              new PublicKey(account.mint),
              keypair.publicKey,
              amount,
              [],
              account.programId
            )
          );
        }
        
        // Then close the account
        transaction.add(
          createCloseAccountInstruction(
            account.address,
            keypair.publicKey,
            keypair.publicKey,
            [],
            account.programId
          )
        );
      }

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [keypair],
        { 
          commitment: 'confirmed',
          skipPreflight: false,
          maxRetries: 3
        }
      );

      return { success: accounts.length, signature };
    } catch (error: any) {
      addLog(`❌ Batch error: ${error.message}`);
      return { success: 0, signature: null };
    }
  };

  const processWallet = async (
    connection: Connection,
    privateKey: string,
    walletIndex: number
  ): Promise<ProcessResult> => {
    const startTime = Date.now();
    
    try {
      const keypair = await parsePrivateKey(privateKey);
      const walletAddress = keypair.publicKey.toBase58();
      const shortAddr = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
      
      addLog(`\n📍 Wallet ${shortAddr}`);
      
      const allAccounts = await getAllTokenAccounts(connection, keypair.publicKey);
      
      if (allAccounts.length === 0) {
        addLog(`⚠️ No accounts found`);
        return {
          wallet: walletAddress,
          status: 'no_accounts',
          accountsClosed: 0,
          solReclaimed: 0,
          message: 'No token accounts',
          signatures: [],
          timeMs: Date.now() - startTime
        };
      }

      addLog(`Found ${allAccounts.length} accounts (${allAccounts.filter(a => a.balance > 0).length} with tokens, ${allAccounts.filter(a => a.balance === 0).length} empty)`);

      let totalClosed = 0;
      const signatures: string[] = [];

      // Process in batches
      for (let i = 0; i < allAccounts.length; i += BATCH_SIZE) {
        const batch = allAccounts.slice(i, i + BATCH_SIZE);
        addLog(`🔥 Closing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allAccounts.length / BATCH_SIZE)} (${batch.length} accounts)...`);
        
        const result = await closeAccountsBatch(connection, keypair, batch);
        
        if (result.success > 0 && result.signature) {
          totalClosed += result.success;
          signatures.push(result.signature);
          addLog(`✅ Closed ${result.success} accounts`);
        }
        
        // Small delay between batches
        if (i + BATCH_SIZE < allAccounts.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const solReclaimed = totalClosed * 0.002;
      addLog(`💰 Total reclaimed: ${solReclaimed.toFixed(4)} SOL`);

      return {
        wallet: walletAddress,
        status: totalClosed > 0 ? 'success' : 'error',
        accountsClosed: totalClosed,
        solReclaimed,
        message: `Closed ${totalClosed}/${allAccounts.length} accounts`,
        signatures,
        timeMs: Date.now() - startTime
      };
    } catch (error: any) {
      addLog(`❌ Wallet failed: ${error.message}`);
      return {
        wallet: `Wallet ${walletIndex + 1}`,
        status: 'error',
        accountsClosed: 0,
        solReclaimed: 0,
        message: error.message,
        signatures: [],
        timeMs: Date.now() - startTime
      };
    }
  };

  const parsePrivateKey = async (privateKeyString: string): Promise<Keypair> => {
    try {
      const keyArray = JSON.parse(privateKeyString);
      return Keypair.fromSecretKey(Uint8Array.from(keyArray));
    } catch {
      const bs58 = await import('bs58');
      return Keypair.fromSecretKey(bs58.default.decode(privateKeyString));
    }
  };

  const startProcessing = async () => {
    if (PRIVATE_KEYS.length === 0) {
      alert('No private keys in privateKeys.ts');
      return;
    }

    setProcessing(true);
    setResults([]);
    setLogs([]);
    setProgress({ current: 0, total: PRIVATE_KEYS.length });
    
    addLog('🚀 Starting direct RPC close operation...');
    addLog('No external APIs - using direct Solana transactions!');
    
    const startTime = Date.now();
    const connection = new Connection(RPC_URL, 'confirmed');
    const allResults: ProcessResult[] = [];

    for (let i = 0; i < PRIVATE_KEYS.length; i += PARALLEL_WALLETS) {
      const batch = PRIVATE_KEYS.slice(i, i + PARALLEL_WALLETS);
      
      const batchResults = await Promise.all(
        batch.map((pk, idx) => processWallet(connection, pk, i + idx))
      );

      allResults.push(...batchResults);
      setResults([...allResults]);
      setProgress({ 
        current: Math.min(i + PARALLEL_WALLETS, PRIVATE_KEYS.length), 
        total: PRIVATE_KEYS.length 
      });
    }

    const totalTime = (Date.now() - startTime) / 1000;
    addLog(`\n✅ Complete in ${totalTime.toFixed(2)}s!`);
    setProcessing(false);
  };

  const totalClosed = results.reduce((sum, r) => sum + r.accountsClosed, 0);
  const totalSol = results.reduce((sum, r) => sum + r.solReclaimed, 0);
  const successWallets = results.filter(r => r.status === 'success').length;

  return (
    <div className={`min-h-screen ${THEME.bg} ${THEME.text} font-sans p-6`}>
      <div className="max-w-5xl mx-auto space-y-6">
        
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3">
            <div className="w-14 h-14 bg-gradient-to-br from-pink-500 to-purple-600 border-2 border-pink-400 flex items-center justify-center font-black text-3xl rounded-lg">
              ⚡
            </div>
            <h1 className="text-4xl font-black tracking-tight bg-gradient-to-r from-pink-400 to-purple-500 bg-clip-text text-transparent">
              DIRECT RPC CLOSER
            </h1>
          </div>
          <p className="text-gray-400 text-sm">
            Fast, direct Solana transactions - No APIs, No delays!
          </p>
        </div>

        <div className="bg-gradient-to-r from-green-900/50 to-emerald-900/50 border-2 border-green-500 p-4 rounded-lg">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚡</span>
            <div>
              <p className="font-bold text-green-200 mb-1">Direct RPC = Fast & Reliable!</p>
              <ul className="text-sm text-green-100 space-y-1">
                <li>• <strong>No external APIs</strong> - Direct to Solana blockchain</li>
                <li>• <strong>Auto burn + close</strong> - Handles tokens with balance automatically</li>
                <li>• <strong>Batch transactions</strong> - Close 5 accounts per transaction</li>
                <li>• <strong>Real rent reclaim</strong> - 0.002 SOL per account returned to you</li>
              </ul>
            </div>
          </div>
        </div>

        <div className={THEME.card}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <span className="bg-gradient-to-r from-pink-500 to-purple-600 text-white w-8 h-8 flex items-center justify-center rounded-full">📁</span>
              Private Keys
            </h2>
            <div className="text-2xl font-black text-pink-400">{PRIVATE_KEYS.length}</div>
          </div>
          
          {PRIVATE_KEYS.length === 0 && (
            <div className="bg-gray-800 p-4 rounded-lg text-sm">
              <p className="text-gray-300 mb-2 font-bold">Create privateKeys.ts:</p>
              <pre className="bg-gray-900 p-3 rounded text-xs text-green-400 overflow-x-auto">
{`export const PRIVATE_KEYS = [
  "your_private_key_1",
  "your_private_key_2",
];`}
              </pre>
            </div>
          )}
        </div>

        <button
          onClick={startProcessing}
          disabled={processing || PRIVATE_KEYS.length === 0}
          className={`w-full py-6 text-xl uppercase tracking-wider ${THEME.accent} border-2 border-pink-400 shadow-[4px_4px_0px_0px_rgba(236,72,153,1)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none transition-all rounded-lg`}
        >
          {processing ? `⚡ CLOSING... ${progress.current}/${progress.total}` : 
           PRIVATE_KEYS.length === 0 ? '❌ NO KEYS' :
           `⚡ START CLOSING (${PRIVATE_KEYS.length} WALLETS)`}
        </button>

        {processing && progress.total > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-400">
              <span>Progress</span>
              <span>{progress.current}/{progress.total} ({Math.round((progress.current / progress.total) * 100)}%)</span>
            </div>
            <div className="w-full bg-gray-700 h-4 border-2 border-gray-600 rounded-lg overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-pink-600 to-purple-500 transition-all duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-green-900 border-2 border-green-500 p-4 rounded-lg text-center">
              <p className="text-3xl font-black">{successWallets}</p>
              <p className="text-xs text-green-200 uppercase">Success</p>
            </div>
            <div className="bg-blue-900 border-2 border-blue-500 p-4 rounded-lg text-center">
              <p className="text-3xl font-black">{totalClosed}</p>
              <p className="text-xs text-blue-200 uppercase">Closed</p>
            </div>
            <div className="bg-purple-900 border-2 border-purple-500 p-4 rounded-lg text-center">
              <p className="text-3xl font-black">{totalSol.toFixed(3)}</p>
              <p className="text-xs text-purple-200 uppercase">SOL</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          {logs.length > 0 && (
            <div className={THEME.card}>
              <h2 className="text-lg font-bold mb-3">📋 Live Log</h2>
              <div className="bg-gray-950 p-3 rounded-lg h-80 overflow-y-auto font-mono text-xs">
                {logs.map((log, idx) => (
                  <div key={idx} className="text-green-400 mb-1">{log}</div>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 && (
            <div className={THEME.card}>
              <h2 className="text-lg font-bold mb-3">📊 Results</h2>
              <div className="space-y-2 h-80 overflow-y-auto">
                {results.map((result, idx) => (
                  <div 
                    key={idx}
                    className={`p-3 border-l-4 rounded-lg ${
                      result.status === 'success' ? 'border-green-500 bg-green-900/20' :
                      result.status === 'no_accounts' ? 'border-yellow-500 bg-yellow-900/20' :
                      'border-red-500 bg-red-900/20'
                    }`}
                  >
                    <div className="flex justify-between mb-1">
                      <span className="font-mono text-xs">
                        {result.wallet.slice(0, 6)}...{result.wallet.slice(-6)}
                      </span>
                      <span className={`text-xs font-bold ${
                        result.status === 'success' ? 'text-green-400' : 'text-red-400'
                      }`}>
                        {result.status === 'success' ? '✅' : result.status === 'no_accounts' ? '⚠️' : '❌'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-300">{result.message}</p>
                    {result.solReclaimed > 0 && (
                      <p className="text-xs text-purple-400 font-bold mt-1">
                        +{result.solReclaimed.toFixed(4)} SOL
                      </p>
                    )}
                    {result.signatures.length > 0 && (
                      <div className="flex gap-2 mt-2 flex-wrap">
                        {result.signatures.map((sig, i) => (
                          <a
                            key={sig}
                            href={`https://explorer.solana.com/tx/${sig}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300 underline"
                          >
                            Tx{i + 1}↗
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="bg-gray-800 border border-gray-600 p-4 rounded-lg text-sm">
          <p className="font-bold text-pink-400 mb-2">⚡ Why Direct RPC Works:</p>
          <ul className="list-disc list-inside space-y-1 text-gray-400 text-xs">
            <li><strong className="text-white">No external APIs:</strong> Direct blockchain transactions</li>
            <li><strong className="text-white">Automatic burn:</strong> If account has tokens, burns them first</li>
            <li><strong className="text-white">Batch processing:</strong> Closes 5 accounts per transaction (saves fees!)</li>
            <li><strong className="text-white">Real rent reclaim:</strong> 0.002 SOL per account goes to your wallet</li>
            <li><strong className="text-white">Fast & reliable:</strong> No timeouts, no failed fetches</li>
          </ul>
        </div>

      </div>
    </div>
  );
};

export default DirectCloser;