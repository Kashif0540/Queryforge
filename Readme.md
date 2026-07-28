# Repository Setup Guide

A step-by-step walkthrough for getting QueryForge from your local files onto GitHub, properly configured. This assumes you already have `index.html`, `script.js`, and `README.md` on your machine.

This guide is repo setup only — for what the project does, how to use it, and its full specs, see [README.md](./README.md).

---

## Prerequisites

- [Git](https://git-scm.com/downloads) installed locally (`git --version` to check)
- A [GitHub account](https://github.com/join)
- *(Optional but convenient)* the [GitHub CLI](https://cli.github.com/) (`gh`) — lets you create the repo from your terminal instead of the browser

---

## Step 1: Create the repository

**Option A — GitHub web UI**

1. Go to [github.com/new](https://github.com/new).
2. Repository name: `queryforge` (or whatever you'd like).
3. Set visibility — **Public** if you want it discoverable, **Private** if you'd rather not expose it while you're still testing.
4. Leave "Add a README," "Add .gitignore," and "Choose a license" **unchecked** — you'll add these yourself in the steps below so you control exactly what goes in.
5. Click **Create repository**. GitHub will show you a page with setup commands — keep that tab open for the remote URL.

**Option B — GitHub CLI**

```bash
gh repo create queryforge --public --source=. --remote=origin
```

Use `--private` instead of `--public` if you'd rather keep it closed for now. This also initializes git and sets the remote in one step, so if you use this option you can skip straight to Step 4.

---

## Step 2: Initialize git locally

From the folder containing your three project files:

```bash
cd queryforge
git init
git branch -M main
```

---

## Step 3: Add a `.gitignore` and a `LICENSE` file

QueryForge has no build tooling, so `.gitignore` only needs to cover editor and OS clutter:

```gitignore
# OS files
.DS_Store
Thumbs.db

# Editor folders
.vscode/
.idea/

# Local env files, in case you ever add a proxy/back-end later
.env
.env.local
```

Save that as `.gitignore` in the project root.

The README states an MIT license, so add the matching `LICENSE` file (root of the repo) so GitHub recognizes and displays it automatically:

```
MIT License

Copyright (c) 2026 <Your Name>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Replace `<Your Name>` with your actual name or handle.

---

## Step 4: Protect your API key before you commit anything

`script.js` ships with a placeholder:

```js
const API_KEY = "PASTE_YOUR_GROQ_API_KEY_HERE";
```

**Do not replace this placeholder with your real key before your first commit if the repo is (or might become) public.** Keep the placeholder in the version you push to GitHub, and paste your real key in only on whichever deployed copy you actually run (a Hugging Face Space, GitHub Pages fork, or local copy that never gets pushed).

If you ever *do* accidentally commit a real key:
1. Revoke it immediately at [console.groq.com/keys](https://console.groq.com/keys) and generate a new one — treat the leaked key as compromised the moment it's pushed, regardless of whether you delete the commit afterward.
2. Removing it from git history (`git filter-repo` or the older `git filter-branch`) only matters for cleanliness after that — it does not undo the exposure.

---

## Step 5: Stage, commit, and push

```bash
git add index.html script.js README.md LICENSE .gitignore REPO_SETUP.md
git commit -m "Initial commit: QueryForge — schema-aware SQL generator"
```

If you used Option A in Step 1, add the remote now (GitHub gave you this URL when you created the repo):

```bash
git remote add origin https://github.com/<your-username>/queryforge.git
```

Then push:

```bash
git push -u origin main
```

---

## Step 6: Configure the repo on GitHub

Once it's pushed, a few settings are worth filling in from the repo's **Settings** and main page:

- **About panel** (gear icon next to "About" on the repo's main page):
  - **Description**: something like *"Schema-aware SQL generator — Groq generates the query, sql.js verifies it live in-browser."*
  - **Website**: your deployed URL, once you have one (Hugging Face Space or GitHub Pages — see Step 7)
  - **Topics**: `sql`, `llm`, `groq`, `sqlite`, `webassembly`, `sql-js`, `static-site`, `ai-tools` — these make the repo discoverable in GitHub's topic search
- **Social preview image** *(optional)*: Settings → General → Social preview, if you want a custom card image when the repo link is shared

---

## Step 7 (optional): Deploy straight from the repo with GitHub Pages

Since QueryForge is fully static, you don't strictly need Hugging Face — GitHub Pages will serve it for free directly from this repo:

1. Go to **Settings → Pages**.
2. Under **Source**, choose **Deploy from a branch**.
3. Branch: `main`, folder: `/ (root)`.
4. Save. GitHub will publish to `https://<your-username>.github.io/queryforge/` within a minute or two.

Because your API key placeholder stays in the pushed source, remember: if you edit `script.js` on your GitHub Pages copy to add a real key, that key is exposed to anyone visiting the page, exactly as noted in the README's security section. Pages and Hugging Face Spaces carry the identical tradeoff since both just serve the static files as-is.

---

## Quick reference

```bash
# One-time setup
git init
git branch -M main
git remote add origin https://github.com/<your-username>/queryforge.git

# Every time you make changes
git add .
git commit -m "Describe what changed"
git push
```

That's the whole repo lifecycle for a project this size — no CI, no build step, nothing else required.
