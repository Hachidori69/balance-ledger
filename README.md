# Balance Ledger

A community page for Jack Butcher's BALANCE: look up any wallet's artwork, ink and history, and browse the full register. Not affiliated with Jack Butcher or Visualize Value.

## Files

- `index.html` — the whole site.
- `scripts/snapshot.mjs` — reads every Balance artwork from Ethereum and writes `data/register.json`.
- `.github/workflows/snapshot.yml` — runs the snapshot every 15 minutes on GitHub and commits the result.

The page loads `data/register.json` first, so the register appears instantly. Wallet lookups are always live. If the snapshot is missing, the page reads the register live instead (slower).

## Put it online with GitHub Pages

1. Create a new public repository on GitHub and upload all files in this folder, keeping the folders (`scripts/`, `.github/workflows/`).
2. In the repository, open **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
3. Open the **Actions** tab, enable workflows if asked, select **Update register snapshot**, and click **Run workflow** once. After it finishes, `data/register.json` appears in the repository.
4. Your site is live at `https://<your-username>.github.io/<repo-name>/`.

From then on the snapshot refreshes about every 15 minutes on its own. GitHub may delay scheduled runs at busy times.

## Optional: faster, more reliable data

Free public Ethereum nodes can be slow or rate-limited. A free key from Alchemy or Infura makes the snapshot reliable:

1. Create a free Ethereum mainnet app at alchemy.com and copy its HTTPS URL.
2. In the repository, open **Settings → Secrets and variables → Actions → New repository secret**, name it `RPC_URL`, and paste the URL.

The key stays secret on GitHub. It is never put into the public page.

## Run the snapshot on your own computer

With Node 20 or newer: `node scripts/snapshot.mjs`
