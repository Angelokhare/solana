import { useState } from 'react';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { SendOptions } from '@solana/web3.js';
import { PRIVATE_KEYS } from './privateKeys';

const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=d9b1bdc9-8b34-43e6-9e35-0ab18d67ad4a';
const DESTINATION_ADDRESS = '2BUvu6RZVKtTFHFQAD9VQzKFj5vyoAPoCF6t9rsZgJQP';

const PARALLEL_WALLETS = 10;
const RESERVE_SOL = 0.002;
const CONFIRMATION_TIMEOUT = 60000; // 60 seconds

const THEME = {
  bg: "bg-gradient-to-br from-gray-900 to-black",
  text: "text-white",
  accent: "bg-purple-600 hover:bg-purple-700 text-white font-bold",
  card: "p-6 border-2 border-purple-500 shadow-[4px_4px_0px_0px_rgba(147,51,234,1)] bg-gray-800",
  input: "w-full p-3 border-2 border-gray-600 bg-gray-700 text-white focus:border-purple-500 outline-none",
};

interface SweepResult {
  wallet: string;
  status: 'success' | 'error' | 'insufficient' | 'timeout';
  balanceBefore: number;
  amountSent: number;
  signature: string | null;
  message: string;
  timeMs: number;
}

const SolSweeper = () => {
  const [sweeping, setSweeping] = useState(false);
  const [results, setResults] = useState<SweepResult[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [activeWallets, setActiveWallets] = useState<string[]>([]);
  const [totalTime, setTotalTime] = useState(0);

  const confirmTransaction = async (
    connection: Connection,
    signature: string,
    commitment: 'confirmed' | 'finalized' = 'confirmed'
  ): Promise<boolean> => {
    const startTime = Date.now();
    
    while (Date.now() - startTime < CONFIRMATION_TIMEOUT) {
      try {
        const status = await connection.getSignatureStatus(signature);
        
        if (status?.value?.confirmationStatus === commitment || 
            status?.value?.confirmationStatus === 'finalized') {
          if (status.value.err) {
            console.error('Transaction failed:', status.value.err);
            return false;
          }
          return true;
        }
        
        // Wait 1 second before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('Error checking transaction status:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return false; // Timeout
  };

  const sweepSolFromWallet = async (
    connection: Connection,
    sourceKeypair: Keypair,
    destinationPubkey: PublicKey
  ): Promise<SweepResult> => {
    const startTime = Date.now();
    const walletAddress = sourceKeypair.publicKey.toBase58();
    
    try {
      // Get balance
      const balance = await connection.getBalance(sourceKeypair.publicKey);
      const balanceInSol = balance / LAMPORTS_PER_SOL;
      
      // Check if balance is sufficient
      if (balanceInSol < RESERVE_SOL) {
        return {
          wallet: walletAddress,
          status: 'insufficient',
          balanceBefore: balanceInSol,
          amountSent: 0,
          signature: null,
          message: `Insufficient balance (${balanceInSol.toFixed(6)} SOL < ${RESERVE_SOL} SOL)`,
          timeMs: Date.now() - startTime
        };
      }

      // Calculate amount to send (leave reserve for fees)
      const reserveLamports = Math.floor(RESERVE_SOL * LAMPORTS_PER_SOL);
      const amountToSend = balance - reserveLamports;

      if (amountToSend <= 0) {
        return {
          wallet: walletAddress,
          status: 'insufficient',
          balanceBefore: balanceInSol,
          amountSent: 0,
          signature: null,
          message: 'Amount after fees would be zero or negative',
          timeMs: Date.now() - startTime
        };
      }

      // Create transfer transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: sourceKeypair.publicKey,
          toPubkey: destinationPubkey,
          lamports: amountToSend,
        })
      );

      // Get recent blockhash with confirmed commitment
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.feePayer = sourceKeypair.publicKey;

      // Sign transaction
      transaction.sign(sourceKeypair);

      // Send with proper options - matching commitment levels
      const sendOptions: SendOptions = {
        skipPreflight: false, // Enable preflight for safety
        preflightCommitment: 'confirmed',
        maxRetries: 3
      };

      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        sendOptions
      );

      console.log(`Transaction sent: ${signature}`);

      // CRITICAL: Wait for confirmation
      const confirmed = await confirmTransaction(connection, signature, 'confirmed');

      if (!confirmed) {
        return {
          wallet: walletAddress,
          status: 'timeout',
          balanceBefore: balanceInSol,
          amountSent: 0,
          signature,
          message: 'Transaction sent but confirmation timeout',
          timeMs: Date.now() - startTime
        };
      }

      const amountSentSol = amountToSend / LAMPORTS_PER_SOL;

      return {
        wallet: walletAddress,
        status: 'success',
        balanceBefore: balanceInSol,
        amountSent: amountSentSol,
        signature,
        message: `✅ Confirmed! Sent ${amountSentSol.toFixed(6)} SOL`,
        timeMs: Date.now() - startTime
      };
    } catch (error: any) {
      return {
        wallet: walletAddress,
        status: 'error',
        balanceBefore: 0,
        amountSent: 0,
        signature: null,
        message: `Failed: ${error.message}`,
        timeMs: Date.now() - startTime
      };
    }
  };

  const parsePrivateKey = async (privateKeyString: string): Promise<Keypair> => {
    // Try JSON array format first
    try {
      const keyArray = JSON.parse(privateKeyString);
      return Keypair.fromSecretKey(Uint8Array.from(keyArray));
    } catch {
      // Try base58 format
      try {
        const bs58 = await import('bs58');
        return Keypair.fromSecretKey(bs58.default.decode(privateKeyString));
      } catch (error: any) {
        throw new Error(`Invalid private key format: ${error.message}`);
      }
    }
  };

  const startSweep = async () => {
    if (PRIVATE_KEYS.length === 0) {
      alert('No private keys found in privateKeys.ts');
      return;
    }

    setSweeping(true);
    setResults([]);
    setProgress({ current: 0, total: PRIVATE_KEYS.length });
    setActiveWallets([]);
    
    const overallStartTime = Date.now();
    const connection = new Connection(RPC_URL, 'confirmed');
    const destinationPubkey = new PublicKey(DESTINATION_ADDRESS);
    const allResults: SweepResult[] = [];

    // Process wallets in parallel batches
    for (let i = 0; i < PRIVATE_KEYS.length; i += PARALLEL_WALLETS) {
      const batch = PRIVATE_KEYS.slice(i, i + PARALLEL_WALLETS);
      
      const batchKeypairs = await Promise.all(
        batch.map(async (pk, idx) => {
          try {
            return { keypair: await parsePrivateKey(pk), index: i + idx };
          } catch (error: any) {
            allResults.push({
              wallet: `Wallet ${i + idx + 1}`,
              status: 'error',
              balanceBefore: 0,
              amountSent: 0,
              signature: null,
              message: `Invalid private key: ${error.message}`,
              timeMs: 0
            });
            return null;
          }
        })
      );

      const validKeypairs = batchKeypairs.filter((k): k is { keypair: Keypair; index: number } => k !== null);

      // Show which wallets are being processed
      const walletAddresses = validKeypairs.map(k => {
        const addr = k.keypair.publicKey.toBase58();
        return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
      });
      setActiveWallets(walletAddresses);

      // Process this batch in parallel
      const batchResults = await Promise.all(
        validKeypairs.map(({ keypair }) => 
          sweepSolFromWallet(connection, keypair, destinationPubkey)
        )
      );

      allResults.push(...batchResults);
      setResults([...allResults]);
      setProgress({ 
        current: Math.min(i + PARALLEL_WALLETS, PRIVATE_KEYS.length), 
        total: PRIVATE_KEYS.length 
      });
    }

    const totalTimeMs = Date.now() - overallStartTime;
    setTotalTime(totalTimeMs);
    setSweeping(false);
    setActiveWallets([]);
  };

  const totalSwept = results.reduce((sum, r) => sum + r.amountSent, 0);
  const successfulWallets = results.filter(r => r.status === 'success').length;
  const errorWallets = results.filter(r => r.status === 'error').length;
  const insufficientWallets = results.filter(r => r.status === 'insufficient').length;
  const timeoutWallets = results.filter(r => r.status === 'timeout').length;
  const avgTimePerWallet = results.length > 0 
    ? (results.reduce((sum, r) => sum + r.timeMs, 0) / results.length / 1000).toFixed(2)
    : '0';

  return (
    <div className={`min-h-screen ${THEME.bg} ${THEME.text} font-sans p-6`}>
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3">
            <div className="w-12 h-12 bg-purple-600 border-2 border-purple-400 flex items-center justify-center font-black text-2xl">
              💰
            </div>
            <h1 className="text-4xl font-black tracking-tight">SOL SWEEPER</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Parallel SOL transfer with CONFIRMATION - {PARALLEL_WALLETS} wallets simultaneously
          </p>
        </div>

        {/* Speed Stats */}
        {totalTime > 0 && (
          <div className="bg-green-900 border-2 border-green-500 p-4 rounded">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-bold text-green-200 text-sm">⚡ RESULTS</p>
                <p className="text-xs text-green-100 mt-1">
                  Total: {(totalTime / 1000).toFixed(2)}s | Avg per wallet: {avgTimePerWallet}s | 
                  Confirmed Swept: {totalSwept.toFixed(6)} SOL
                </p>
              </div>
              <div className="text-3xl">✅</div>
            </div>
          </div>
        )}

        {/* Warning Card */}
        <div className="bg-yellow-900 border-2 border-yellow-500 p-4 rounded">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <p className="font-bold text-yellow-200 mb-1">SOL TRANSFER WITH CONFIRMATION</p>
              <p className="text-sm text-yellow-100">
                Transfers all SOL balances leaving {RESERVE_SOL} SOL for fees. WAITS FOR CONFIRMATION. 
                Destination: <span className="font-mono bg-yellow-800 px-2 py-1 rounded text-xs">{DESTINATION_ADDRESS}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Config Card */}
        <div className={THEME.card}>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <span className="bg-purple-600 text-white w-8 h-8 flex items-center justify-center rounded-full">⚙️</span>
            Configuration
          </h2>
          
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 bg-gray-700 rounded">
              <p className="text-gray-400 text-xs">Private Keys</p>
              <p className="font-bold text-purple-400 text-xl">{PRIVATE_KEYS.length}</p>
            </div>
            <div className="p-3 bg-gray-700 rounded">
              <p className="text-gray-400 text-xs">Parallel Wallets</p>
              <p className="font-bold text-blue-400 text-xl">{PARALLEL_WALLETS}</p>
            </div>
            <div className="p-3 bg-gray-700 rounded">
              <p className="text-gray-400 text-xs">Reserve per Wallet</p>
              <p className="font-bold text-yellow-400 text-xl">{RESERVE_SOL} SOL</p>
            </div>
            <div className="p-3 bg-gray-700 rounded">
              <p className="text-gray-400 text-xs">Confirmation Timeout</p>
              <p className="font-bold text-green-400 text-xl">{CONFIRMATION_TIMEOUT / 1000}s</p>
            </div>
          </div>
        </div>

        {/* Action Button */}
        <button
          onClick={startSweep}
          disabled={sweeping || PRIVATE_KEYS.length === 0}
          className={`w-full py-6 text-xl uppercase tracking-wider ${THEME.accent} border-2 border-purple-400 shadow-[4px_4px_0px_0px_rgba(147,51,234,1)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none transition-all`}
        >
          {sweeping ? `⚡ SWEEPING... ${progress.current}/${progress.total}` : `🚀 SWEEP ${PRIVATE_KEYS.length} WALLETS`}
        </button>

        {/* Active Wallets */}
        {activeWallets.length > 0 && (
          <div className="bg-blue-900/30 border border-blue-500 p-3 rounded">
            <p className="text-xs text-blue-300 mb-2 font-bold">⚡ Processing & Confirming:</p>
            <div className="flex flex-wrap gap-2">
              {activeWallets.map((addr, idx) => (
                <span key={idx} className="text-xs font-mono bg-blue-800 px-2 py-1 rounded animate-pulse">
                  {addr}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Progress Bar */}
        {sweeping && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-400">
              <span>Progress</span>
              <span>{progress.current}/{progress.total} ({Math.round((progress.current / progress.total) * 100)}%)</span>
            </div>
            <div className="w-full bg-gray-700 h-4 border-2 border-gray-600">
              <div 
                className="h-full bg-gradient-to-r from-purple-600 to-blue-500 transition-all duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Summary Stats */}
        {results.length > 0 && (
          <div className="grid grid-cols-5 gap-3">
            <div className="bg-green-900 border-2 border-green-500 p-3 rounded text-center">
              <p className="text-2xl font-black">{successfulWallets}</p>
              <p className="text-xs text-green-200 uppercase">Confirmed</p>
            </div>
            <div className="bg-blue-900 border-2 border-blue-500 p-3 rounded text-center">
              <p className="text-xl font-black">{totalSwept.toFixed(4)}</p>
              <p className="text-xs text-blue-200 uppercase">SOL Swept</p>
            </div>
            <div className="bg-yellow-900 border-2 border-yellow-500 p-3 rounded text-center">
              <p className="text-2xl font-black">{insufficientWallets}</p>
              <p className="text-xs text-yellow-200 uppercase">Low Balance</p>
            </div>
            <div className="bg-orange-900 border-2 border-orange-500 p-3 rounded text-center">
              <p className="text-2xl font-black">{timeoutWallets}</p>
              <p className="text-xs text-orange-200 uppercase">Timeout</p>
            </div>
            <div className="bg-red-900 border-2 border-red-500 p-3 rounded text-center">
              <p className="text-2xl font-black">{errorWallets}</p>
              <p className="text-xs text-red-200 uppercase">Errors</p>
            </div>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className={THEME.card}>
            <h2 className="text-xl font-bold mb-4">Results ({results.length})</h2>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {results.map((result, idx) => (
                <div 
                  key={idx}
                  className={`p-3 border-l-4 ${
                    result.status === 'success' ? 'border-green-500 bg-green-900/20' :
                    result.status === 'insufficient' ? 'border-yellow-500 bg-yellow-900/20' :
                    result.status === 'timeout' ? 'border-orange-500 bg-orange-900/20' :
                    'border-red-500 bg-red-900/20'
                  }`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-mono text-xs">
                      {result.wallet.slice(0, 8)}...{result.wallet.slice(-8)}
                    </span>
                    <div className="flex gap-2 items-center">
                      <span className="text-xs text-gray-400">{(result.timeMs / 1000).toFixed(2)}s</span>
                      <span className={`text-xs font-bold ${
                        result.status === 'success' ? 'text-green-400' :
                        result.status === 'insufficient' ? 'text-yellow-400' :
                        result.status === 'timeout' ? 'text-orange-400' :
                        'text-red-400'
                      }`}>
                        {result.status === 'success' ? '✅' :
                         result.status === 'insufficient' ? '⚠️' :
                         result.status === 'timeout' ? '⏱️' : '❌'}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs text-gray-400">
                      Balance: {result.balanceBefore.toFixed(6)} SOL
                    </span>
                    {result.amountSent > 0 && (
                      <span className="text-xs text-green-400 font-bold">
                        Sent: {result.amountSent.toFixed(6)} SOL
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-300 mb-2">{result.message}</p>
                  {result.signature && (
                    <a
                      href={`https://explorer.solana.com/tx/${result.signature}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 underline"
                    >
                      View Transaction ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Performance Notes */}
        <div className="bg-gray-800 border border-gray-600 p-4 rounded text-sm space-y-2">
          <p className="font-bold text-gray-300">✅ FIXES APPLIED:</p>
          <ul className="list-disc list-inside space-y-1 text-gray-400 text-xs">
            <li><strong className="text-green-400">Transaction Confirmation:</strong> Now waits for confirmed status before marking as success</li>
            <li><strong className="text-green-400">Preflight Enabled:</strong> Catches errors before sending to prevent failed transactions</li>
            <li><strong className="text-green-400">Matching Commitment:</strong> Uses 'confirmed' for both blockhash and transaction</li>
            <li><strong className="text-green-400">Proper Retries:</strong> RPC handles 3 retries automatically</li>
            <li><strong className="text-green-400">Timeout Handling:</strong> 60-second timeout per transaction with status tracking</li>
          </ul>
          <p className="text-xs text-blue-400 mt-2">
            💡 This will be slower but RELIABLE - your SOL will actually arrive in the destination wallet
          </p>
        </div>

      </div>
    </div>
  );
};

export default SolSweeper;