# 以後只上傳這個資料夾的內容

唯一資料夾：`慢慢記-手機與個股成果版`。目前版本 **1.3.0 · 自動行情與分類提醒版**。

今後程式修改直接在這裡進行，不再另外交付「全新版本」或 ZIP。電腦檔案不會自己同步到 GitHub；每次修改完成後，仍由你把這個資料夾內的內容上傳。上傳成功並發布後，網站才更新。

你的儲存庫：[Goodgreatgreat/4](https://github.com/Goodgreatgreat/4)

你的網站：[https://goodgreatgreat.github.io/4/](https://goodgreatgreat.github.io/4/)

## 這次為何仍看到合併看

2026-09-08 唯讀查核結果：GitHub `main` 分支的 `index.html` 已是沒有舊按鈕的新版；但網站實際回傳的 HTML 仍含 `id="merge"` 舊按鈕。這表示讀到的已發布頁面與主分支檔案不同，不能只歸因為你手機的快取。

同時 GitHub 只有最外層散檔，缺少整個 `.github`、`data`、`tools`、`tests`、`optional` 資料夾；目前執行的是 GitHub 預設的 `pages build and deployment`，不是本程式的「更新官方台股行情並發布」。因此自動抓台股行情的流程沒有被上傳，也沒有執行。

## 第一步：先備份，不更換網址

先在原網站匯出你的帳本備份。繼續使用同一個 `4` 儲存庫及網站路徑，不用刪除整個儲存庫，也不要清除瀏覽器網站資料。帳本保存在手機，不在這些 GitHub 程式檔中。

## 第二步：GitHub 可以刪除的舊檔

以下是這次查核時**確實存在**且新版不再使用的項目，只刪這些：

```text
app.js
icon.svg
ledger.js
performance.js
storage.js
styles.css
sw.js
tiingo.js
tw-quotes.js
慢慢記-全新GitHub版.zip
```

注意：不要把 `main.js` 當成 `app.js` 刪掉；新版用 `main.js`。不要把 `ui.css` 當成 `styles.css`；新版用 `ui.css`。不要把 `offline.js` 當成 `sw.js`；新版用 `offline.js`。

其他同名檔案（例如 `index.html`、`README.md`、`package.json`）直接用這次資料夾中的版本覆蓋。若之後出現這張清單外的未知檔案，不要整批猜測刪除。

## 第三步：上傳全部內容，包含資料夾

1. 在檔案總管打開「慢慢記-手機與個股成果版」。
2. 到 GitHub 儲存庫最外層，選 **Add file → Upload files**。
3. 將這個資料夾**裡面的所有檔案及子資料夾**拖進 GitHub 上傳區，再 Commit changes。不要只挑 HTML／JS 散檔；不要把整個「慢慢記-手機與個股成果版」外層包進去，也不要上傳 ZIP。
4. 最外層必須直接看得到 `index.html`；另外一定要看到以下結構：

```text
儲存庫最外層/
  index.html
  main.js、book.js、period.js、results.js、其他程式檔
  ui.css、offline.js、updates.js、quote-status.js、fx.js
  update.html、update-page.js、update-utils.js
  package.json
  .github/
    workflows/
      pages.yml
  data/
    taiwan.json、fx.json
  tools/
    build.mjs、quotes.mjs、twse.mjs、fx.mjs、serve.mjs
  tests/
    所有 .test.mjs
  optional/
    tiingo-worker.js
```

`tests` 不是帳本資料；自動發布會執行測試，所以不能漏。`data/taiwan.json` 是公開股票行情，不是私人紀錄。`optional` 是可選美股中繼程式，不含 Token。

若 `.github` 沒有上傳成功，可以用 **Add file → Create new file**，完整輸入 `.github/workflows/pages.yml`，再把電腦同名檔案內容貼進去。其他資料夾也必須確實存在。

## 第四步：改為正確的發布方式

1. [Settings → Pages](https://github.com/Goodgreatgreat/4/settings/pages)，將 **Source 選 GitHub Actions**，不要繼續使用 Deploy from a branch。
2. 開啟 [Actions](https://github.com/Goodgreatgreat/4/actions)，應出現 **更新官方台股行情並發布**。
3. 點這個流程 → **Run workflow** → 選 `main` → 執行。等整個流程綠色完成。
4. 若完全沒有這個流程，代表 `.github/workflows/pages.yml` 還沒上傳成功，不是等待就會好。
5. 若流程紅色失敗，開啟錯誤步驟再提供訊息，不要當成發布完成。

流程會從這次程式自動產生網站並發布。請勿手動上傳 `dist`；它由流程生成。GitHub 官方說明：[使用自訂 Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 第五步：更新舊畫面，不清除帳本

發布成功後開網站，頁尾應顯示 **慢慢記 1.3.0 · 自動行情與分類提醒版**，合併改在帳戶選單中的「全部帳戶」，不再有獨立按鈕。

若仍看到舊畫面：儲存目前輸入、先匯出備份，關閉其他本網站分頁，再開 [本網站更新修復頁](https://goodgreatgreat.github.io/4/update.html)，按「更新程式畫面並回到記帳」。它只處理此網站的程式快取與離線註冊，不會清除帳本或 Token。這個入口須等本次檔案發布成功才存在。

之後程式會在開啟／回到網站時檢查更新，有新版時提示「套用新版」；由你按下後載入，避免打字到一半被自動刷新。底部也可手動檢查。技術機制參考：[ServiceWorkerRegistration.update](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/update)。

台股資料則依排程在平日台灣時間約 17:17、19:17 抓取並發布（含永豐每日牌告匯率），GitHub 排程可能延遲。每檔仍顯示官方行情日期。這不代表本機程式會自動同步到 GitHub。

## 哪些不能上傳

個人帳本備份、Excel、救援檔、API Token 都不要上傳。只上傳本資料夾提供的程式與公開行情資料。

本機雙擊 `index.html` 會得到 `file:///...`，不是你的 GitHub 網站，可能無法執行 JavaScript 模組；請使用上面的 HTTPS 網址。
