# Connected-wallet and Vercel verification

Updated 9 November 2026 (Asia/Karachi).

- JavaScript syntax checks: passed, including Vercel API functions.
- Automated suite: 146 tests passed, zero failures. Covers EIP-6963/EIP-1193 discovery and account events; explicit chain switching; immutable ETH/USDC reviews; account/chain/nonce/balance/fee rechecks; one wallet request per review; rejection and ambiguous-outcome handling; local recovery isolation; exact USDC event proof; replacement transactions; disabled server signing; read-only RPC allowlisting; Vercel parsed bodies and hosted origins; rate limits; deployment exclusions.
- Build: passed. The public output contains the local ethers browser bundle. No environment or submission files are copied.
- Real Chrome with simulated wallet/API: passed connection, explicit network switching, exact USDC review, one simulated eth_sendTransaction, mined receipt/event proof, disconnect, and public lookup. No actual wallet, key, signature or blockchain broadcast was used.
- Desktop and mobile screenshots were inspected: artifacts/wallet-desktop.png and artifacts/wallet-mobile.png. No browser JavaScript errors or horizontal mobile overflow.
- The Vercel-ready package was checked against the configured local private key and signing password without printing either. Neither is copied; the package has no local .env or data directory, and contains no legacy signer module.

The deployed application uses only static public assets and read-only Node functions. Old local signing modules and public submission history are preserved in the original workspace but are excluded from the deployment package and Vercel uploads.

Publishing still requires the user's Vercel account connection. A real funded wallet approval remains a user action; use Sepolia for the first deployment check. Supported connections are injected desktop browser wallets and compatible mobile wallet browsers; external WalletConnect QR pairing is not included.

Final running-app checks: connected-wallet health mode, disabled legacy signer (HTTP 410), connected-wallet interface, and a real successful Sepolia receipt through the public read-only API all passed after restart. No wallet transaction was requested.
