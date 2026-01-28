import { 
  Connection, 
  PublicKey, 
  SystemProgram, 
  Transaction, 
  // LAMPORTS_PER_SOL 
} from "@solana/web3.js";
import { 
  getAssociatedTokenAddress, 
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";

// --- Constants ---
export const MAX_BATCH_SIZE = 100; // Total recipients allowed
export const MAX_TX_SIZE_SOL = 12; // Max SOL recipients per transaction
export const MAX_TX_SIZE_SPL = 10; // Max SPL recipients per transaction
export const SOL_MINT = "SOL";

// --- Interfaces ---
export interface Recipient {
  address: string;
  amount: string; // Keep as string for input handling
}

// --- Validation Helpers ---
export const isValidAddress = (address: string): boolean => {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
};

// --- SPL Token Helpers ---

// Check if a wallet has an Associated Token Account (ATA) initialized
export const checkRecipientATA = async (
  connection: Connection,
  recipientAddress: string,
  mintAddress: string
): Promise<boolean> => {
  try {
    const mint = new PublicKey(mintAddress);
    const recipient = new PublicKey(recipientAddress);
    const ata = await getAssociatedTokenAddress(mint, recipient);
    const info = await connection.getAccountInfo(ata);
    return info !== null; // Returns true if ATA exists
  } catch (e) {
    return false;
  }
};

export const getTokenDecimals = async (connection: Connection, mintAddress: string): Promise<number | null> => {
  try {
    const mint = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mint);
    return mintInfo.decimals;
  } catch (e) {
    return null;
  }
};

// --- Core Transaction Builder ---
// Returns an ARRAY of transactions to handle large batches

export const buildMultiSendTransaction = async (
  connection: Connection,
  sender: PublicKey,
  recipients: Recipient[],
  tokenMint: string,
  decimals: number = 9,
  autoCreateATA: boolean = true
): Promise<Transaction[]> => {
  const transactions: Transaction[] = [];
  const isSol = tokenMint === SOL_MINT;
  
  // Determine chunk size based on token type
  // SOL transfers are smaller, so we can fit more per transaction
  const chunkSize = isSol ? MAX_TX_SIZE_SOL : MAX_TX_SIZE_SPL;
  
  // Split recipients into chunks
  const chunks: Recipient[][] = [];
  for (let i = 0; i < recipients.length; i += chunkSize) {
    chunks.push(recipients.slice(i, i + chunkSize));
  }

  // Build a separate transaction for each chunk
  for (const chunk of chunks) {
    const transaction = new Transaction();
    
    // Get latest blockhash for transaction validity
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = sender;

    for (const recipient of chunk) {
      const recipientPubkey = new PublicKey(recipient.address);
      const amountBig = BigInt(Math.round(parseFloat(recipient.amount) * Math.pow(10, decimals)));

      if (isSol) {
        // 1. SOL Transfer Logic
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: recipientPubkey,
            lamports: amountBig,
          })
        );
      } else {
        // 2. SPL Token Logic (transferChecked)
        const mintPubkey = new PublicKey(tokenMint);
        const senderATA = await getAssociatedTokenAddress(mintPubkey, sender);
        const recipientATA = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

        // Check if recipient ATA exists
        const ataExists = await connection.getAccountInfo(recipientATA);
        
        // If ATA doesn't exist and autoCreateATA is enabled, create it first
        if (!ataExists && autoCreateATA) {
          transaction.add(
            createAssociatedTokenAccountInstruction(
              sender,           // payer (who pays for the account creation)
              recipientATA,     // associatedToken (the ATA address)
              recipientPubkey,  // owner (recipient owns the ATA)
              mintPubkey,       // mint
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }

        // We use transferChecked for safety (verifies mint and decimals match)
        transaction.add(
          createTransferCheckedInstruction(
            senderATA,      // source
            mintPubkey,     // mint
            recipientATA,   // destination
            sender,         // owner
            amountBig,      // amount
            decimals        // decimals
          )
        );
      }
    }

    transactions.push(transaction);
  }

  return transactions;
};