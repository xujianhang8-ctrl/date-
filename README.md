# sorry, Poo

A tiny apology game in one file, `index.html`. It takes about 3 minutes to play and there's no way to lose.

| Level | What it's about | How it plays |
| --- | --- | --- |
| 1. Slow down | not being careful enough | Move me left and right to catch 10 hearts and dodge my careless mistakes. |
| 2. Mind my tone | not checking my tone | Turn the tone dial from "grumpy" until I sound kind. Turn it too far and it gets cheesy. |
| 3. Check my own work | making her do extra work | Proofread my report. Partway through, I take the pen back and fix the rest myself. |
| 4. Your turn to rest | the sleep she lost | Tap her worries away until the room goes quiet. |

Each level ends with an apology and a heart. All 4 hearts unlock a letter, a question with a "Not yet" option that's respected, and some coupons.

## Sending it

- **As a file:** `index.html` has the fonts embedded, so it works on its own on a phone or laptop, even offline.
- **As a link (GitHub Pages):** go to *Settings → Pages → Build and deployment*, choose *Deploy from a branch*, pick the branch that has `index.html` and the `/ (root)` folder, and save. The link will be `https://xujianhang8-ctrl.github.io/sorry-poo/`. Pages on a private repo needs a paid GitHub plan.

## Changing the words

- Her name and your signature: near the bottom of `index.html`, at the top of the `<script>`:
  ```js
  const HER_NAME = "Poo";   // what the game calls her
  const SIGNED = "me";      // how the letter is signed
  ```
- Level text: `LEVELS` (intro, apology, and promise for each level), `ROUNDS` (tone dial lines), `DOC` (the report, where `{wrong|right}` marks a mistake), and `WORRIES` (the night level).
- The letter and coupons: plain HTML inside `<article class="letter">` and `<div class="coupons">`.

## Credits

Handwriting fonts: [Gaegu](https://fonts.google.com/specimen/Gaegu) and [Mali](https://fonts.google.com/specimen/Mali), both under the SIL Open Font License 1.1. The license texts are in `licenses/`.
