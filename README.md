# Deck Ledger

A local-first Commander deck-strength tracker. Log pods and winners; the app fits ratings for every player and deck from the full game history (seeds as priors, uncertainty shown, deck updates handled as new versions).

All data stays on your device (browser localStorage) and is saved automatically after every change. Use More > Export backup now and then as a safety copy. On iPhone, add to Home Screen first and use only that icon (Safari and the Home Screen app keep separate data).

## Host on GitHub Pages
1. Create a new public repository (e.g. `deck-ledger`) and upload every file in this folder to its root.
2. Settings > Pages > Build and deployment > Deploy from a branch > `main` / `(root)` > Save.
3. After a minute, open `https://<your-username>.github.io/deck-ledger/` on your phone.
4. iPhone: Share > Add to Home Screen. Android: menu > Install app / Add to Home screen.

The site is public, but it contains only the app code. Your games never leave your device.

## Luck: who went first and mulligans
After a game, the Result screen asks who won, who went first and how many mulligans each seat took (both optional). The app learns how much going first and taking two or more mulligans matter from the games that record them, and allows for it, so a deck that lost after a bad mulligan takes less of the blame. Stats shows the learned effects; More > Luck switches either off.

A "patch" file (it has `"deckLedgerPatch": 1` at the top) fills in who went first and mulligans on games you already have, matched by game and player. Import it like a backup. It only fills blanks: a game where you have recorded either yourself keeps your values, and nothing else changes, so importing it again is harmless.

## Table size
In 4- and 5-player pods the gaps between seats count for less than in 3-player pods (3-player is the reference). The app learns by how much in the background (`worker.js`): it predicts each big-pod game from all the others and finds the factor that makes those predictions honest, starting from "no difference". It re-learns after every five new 4-player or three new 5+-player games. 6+-player pods share the 5-player factor. Stats shows the learned values; More > Luck and table size switches it off.

## Estimates and hindsight
Each estimate records when it was set (estimates made before this feature are stamped the first time the new version opens). Editing the estimate of a deck you have played against asks first: results are already in its rating, so only change it for something new you have learned, such as the list. Stats > Fresh test of your estimates scores your estimates on games logged after they were set, which no hindsight can touch.

## Which deck should I bring?
On the Log a game screen, once you and at least one opponent are seated, "Which of my decks fits this table?" ranks your decks: by win chance (decks and players), or by deck power only (rating gap to the table's average deck, ignoring who is playing). Unknown opponent decks use the player's usual level, else the average of their decks. Tap a deck to put it in your seat.

## Backups
Your data lives only in this browser. More > Export backup opens the share sheet (or downloads the file): save it to iCloud Drive, Google Drive or an email to yourself. After five or more games and two weeks without a backup, the Decks screen shows a reminder (dismiss it for a week with the cross).

## Updating
Upload the new files over the old ones. The service worker (`sw.js`) keeps the app working offline; its cache name changes with each release so phones pick up the new version the next time the app is opened online.
