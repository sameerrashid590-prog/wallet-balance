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

## MetaMask mobile Chrome connection repair — 9 November 2026

- Added official @metamask/connect-evm 2.1.1 with a lazy browser bundle built using esbuild. Browser-wallet discovery still works; mobile Chrome/Safari now has MetaMask app / QR without an injected provider.
- Pairing uses MetaMask's session-bearing app link and encrypted relay, with analytics disabled. The frontend never receives an account private key. SDK-managed pairing session storage is distinct from the app's public transfer records.
- Added selected-chain permissions, passive SDK restoration, refresh on return to the browser, immediate cancellation and late-result protection. Added an explicit HTTPS in-app-browser fallback.
- CSP permits only MetaMask's relay plus the three configured public read RPC hosts; no unsafe-eval or global connect wildcard was added. Vercel and local headers match.
- 154 automated tests passed, zero failures; syntax and production build passed. Existing desktop/USDC browser smoke passed.
- Mobile Chrome emulation loaded the real production SDK, generated its protocol-bearing MetaMask app link under CSP, and passed simulated approval, silent reload restoration, cancellation and late-approval rejection without an injected wallet. No real MetaMask account or transfer was used. Physical-phone app pairing still needs a device check after redeploy.
- npm reported zero vulnerabilities after pinning the compatible uuid v4 helper to patched uuid 11.1.1. MetaMask SDK pairing initialization and transport-link generation were exercised with the patched dependency.
- User-managed deployment is retained. No ChatGPT Vercel integration or new environment variable is needed. Push the code and redeploy to update the live site.
