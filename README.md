# EtherReceipt

Public ETH and native USDC payments, approved in each visitor's connected wallet. The site never requests a private key or seed phrase. The API is read-only and cannot sign or broadcast transactions.

## Run locally

Use Node.js 24 and npm:

~~~powershell
npm ci
npm run check
npm run build
npm start
~~~

Open http://localhost:3000. The optional local .env is used for RPC configuration only. Existing local files and old submission history are preserved; no old sending account is loaded by this application.

## Deploy to Vercel

1. Import this project into Vercel, or run npx vercel from the project folder after signing into your Vercel account.
2. Choose **Other** as the framework and **Node.js 24.x**. vercel.json supplies the build command (npm run build) and output directory (public).
3. Deploy. No environment variables are required for the default public RPC endpoints.
4. Optionally configure MAINNET_RPC_URL, SEPOLIA_RPC_URL, HOODI_RPC_URL, BLOCKSCOUT_API_KEY and REQUEST_TIMEOUT_MS in Vercel's environment settings to use your own read providers. These settings stay server-side. Redeploy after changing them.

Do not upload the local .env or configure a wallet private key or signing password in Vercel. .vercelignore excludes local environment files, historical data, artifacts and retired server-signer modules. Only the public assets and read-only API dependency graph are needed. The build copies the installed ethers browser bundle into public/vendor; it never copies configuration or wallet history.

Vercel runs the handlers in api/ as Node functions. It does not start server.js or require a writable disk/database. See [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js) and [project configuration](https://vercel.com/docs/project-configuration).

## Connect and send

- Connect an installed EIP-1193/EIP-6963 browser wallet, such as MetaMask, Rabby or Coinbase Wallet. Multiple announced wallets appear in the wallet selector. On a phone, open the site inside a compatible mobile wallet's browser. External QR/WalletConnect sessions are not included in this version.
- Choose the network explicitly. If the wallet is on another chain, use **Switch to ...** and approve that switch in the wallet.
- Enter the receiver and amount, then review the sender, network, asset, nonce and maximum ETH fee. This only reads blockchain data.
- Click **Approve ... in wallet**. The app rechecks the account, chain, balances, pending nonce and fee cap before requesting eth_sendTransaction. The wallet shows the transaction and owns all signing. The site never asks for a separate message signature or token approval.
- Check the amount, receiver and network in the wallet before approving. Rejecting the wallet request releases the review. A wallet/network error after submission begins is treated as uncertain and is never retried automatically.
- Receipt polling checks the exact hash. USDC requires the intended token contract, sender, recipient, amount and matching Transfer event before a payment is reported as successful. A receipt is not a claim of finality against chain reorganizations.

Mainnet (1), Sepolia (11155111) and Hoodi (560048) are available for ETH. Native USDC is pinned to Circle's Ethereum Mainnet and Sepolia deployments; Hoodi USDC is unsupported. Sending requires a plain account; direct ETH receiving contracts and delegated/smart sending accounts need a different transfer flow. All USDC gas is paid in ETH on the selected chain. The app never switches assets or networks silently.

## Pending payments and recovery

Only public recovery data (address, nonce, network, reviewed transaction and returned hash) is stored in this browser's localStorage. Pending records are isolated by sending address and chain; one visitor cannot block another visitor. Connection restoration uses eth_accounts without prompting for permissions again. Public lookups need no connection.

If a wallet response is lost or the tab closes before a hash returns, connect the same wallet and chain again. Copy the **transaction hash** from the wallet's activity into the recovery field. This is a public hash, not a credential. The app verifies the sender, chain and nonce before accepting it. Same-nonce speed-ups and cancellations can be recovered too; a different payment is labeled as a replacement rather than the intended payment.

Keep browser storage until pending payments are reconciled. Do not create a second payment just because a request timed out. New sends on that account and chain stay blocked until the tracked request is resolved. Browsers supporting Web Locks also serialize wallet requests across tabs.

## Server boundaries

The hosted API exposes only /api/health, /api/rpc, /api/usdc and /api/history. RPC methods and parameters are allowlisted; eth_sendTransaction, eth_sendRawTransaction, arbitrary contract calls and browser-supplied RPC URLs are rejected. All former /api/sender routes are disabled. No server signer, journal, login or shared sending wallet is used. Historical local-signer modules/tests remain on disk for regression history, are not imported by the application, and are excluded from Vercel uploads.

Requests have bounded payload sizes/timeouts, security headers, same-origin checks and a best-effort per-client limit within each function instance. Use Vercel edge controls/provider quotas for deployment-wide abuse limits. Public RPCs and indexers can still be unavailable or rate-limited; the UI reports those errors and never substitutes demo results for live data.

## Verification

npm run check runs syntax and automated tests. npm run build prepares the deployment assets. scripts/browser-smoke.js exercises a simulated browser wallet and mocked blockchain responses, including exact USDC receipt proof, with no real keys, signing or broadcasts. It accepts optional Playwright module and Chrome executable paths when those tools are installed outside this project.

A funded real-wallet transfer remains a user action. Prefer Sepolia when checking a new deployment.
