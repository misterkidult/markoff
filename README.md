# markoff

在活的網頁上標記，標完就結束。

設計師打開已部署的預覽網址，點畫面上任何元素、打字、按留言——意見就帶著
「當時是在什麼裝置、什麼寬度看的」一起留下來，前端不必再回頭問「你說的是哪一個」。

單檔、零依賴、不需要後端。一行 script 裝上去，留言存在瀏覽器裡，隨時匯出 JSON。
要送到自己的服務（Google Sheets、Notion、Slack、任何 API）就掛一個 callback。

**只在預覽階段用。** 正式上線前把這行 script 拿掉。

**[開 demo 玩玩看 →](https://demo.coreplay.tw/markoff/)**

---

## 裝起來

下載 [`src/markoff.js`](src/markoff.js) 放進專案，在 `</body>` 前加一行：

```html
<script src="/markoff.js" data-project="my-site" defer></script>
```

或直接從 jsDelivr 取用，什麼都不用複製：

```html
<script src="https://cdn.jsdelivr.net/gh/misterkidult/markoff@main/src/markoff.js"
        data-project="my-site" defer></script>
```

然後開 `你的網址/?comment=1`，左下角出現「留言」按鈕。

**沒有 `?comment=1` 的一般訪客完全看不到任何東西**，所以這行可以跟正式站一起部署，
不需要另外開一個預覽環境。

| 屬性 | 用途 |
|---|---|
| `data-project` | 標記歸在哪個案子底下，會一起送出／匯出方便篩選。省略時用網站網域 |
| `data-endpoint` | 留言 POST 到這個網址。省略時是純本機模式 |

## 怎麼用

1. 按「留言」進入標註模式
2. 點畫面上任何元素 → 打字 → 按「留言」
3. 已標註的元素會有紅色虛線框，編號 pin 掛在左上角
4. 點 pin 可以改內容或刪除
5. 按「匯出」下載 JSON

**沒有第二顆送出鈕。** 早期版本是累積數則後再一次送出，實測最容易漏掉那個動作——
標了一下午，關掉分頁才發現什麼都沒送出去。現在按下留言就是送出。

留言存在 `localStorage`，關瀏覽器不會消失。

## 收集了什麼

每則留言長這樣：

```json
{
  "id": "12dacc3b-25d4-416e-a3da-ebec36bd7887",
  "n": 3,
  "note": "這行對比不夠，灰得看不清楚",
  "element": {
    "selector": "div.wrap > div.card > p",
    "tag": "p",
    "text": "這行文字的對比可能不太夠…",
    "rect": { "x": 45, "y": 718, "w": 178, "h": 76 },
    "computed": {
      "fontSize": "16px", "fontWeight": "400", "lineHeight": "28px",
      "color": "rgb(153, 153, 153)", "backgroundColor": "rgba(0, 0, 0, 0)"
    }
  },
  "anchor": { "x": 120, "y": 740 },
  "device": {
    "viewport": { "w": 1440, "h": 900 },
    "screen": { "w": 1920, "h": 1080, "ratio": 75 },
    "breakpoint": "desktop", "breakpointLabel": "桌機",
    "orientation": "landscape", "input": "mouse",
    "dpr": 2, "retina": true,
    "os": "macOS", "browser": "Chrome", "browserVersion": "148", "model": "Mac"
  },
  "at": "2026-08-18T14:12:42.613Z"
}
```

`device` 這一段是重點：**同一句「這裡太擠」，在手機和桌機是兩個問題。**

- `breakpoint` 分五級（手機／大手機／平板／桌機／大桌機）
- `input` 區分觸控與滑鼠——「真的用 iPhone 看」和「把桌機視窗縮窄」是不同情境
- `screen.ratio` 是視窗佔螢幕多少。明顯小於 100 代表對方是**刻意**縮窄測 RWD，
  不是螢幕本來就這麼小
- `computed` 先收好最常被抱怨的幾個屬性，省得回頭問「現在幾 px」

⚠ **iPhone 抓不到型號。** Apple 自 iOS 12 起把所有 iPhone 的 userAgent 統一，
分不出 15 或 16，`model` 只會是 `"iPhone"`。想推機型只能靠 `screen` 自行判讀——
那是猜測不是事實，所以這裡不猜。Android 則在 UA 裡帶了型號字串，抓得到。

## 接自己的後端

掛一個 `onSubmit`，回傳 Promise。resolve 表示送成功（pin 變實心），
reject 表示失敗（之後自動重試）。

```html
<script src="/markoff.js" data-project="my-site" defer></script>
<script>
  window.addEventListener('load', () => {
    if (!window.markoff) return;   // 沒有 ?comment=1 時不會載入
    markoff.onSubmit = async (payload) => {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('送出失敗');
    };
  });
</script>
```

只要是單純 POST，用 `data-endpoint` 就夠了，不用寫 callback：

```html
<script src="/markoff.js" data-endpoint="/api/comments" defer></script>
```

### payload 的三種形狀

`action` 有三種，三種都處理才支援改與刪。只實作 `create` 也能動，
改與刪會一直重試不成功。

```js
// 新增
{ project, page: { url, path, title }, action: 'create', comment: { …見上方 } }

// 改內容
{ project, page, action: 'update', id: '12dacc3b…', note: '改過的內容' }

// 刪除
{ project, page, action: 'delete', id: '12dacc3b…' }
```

`id` 是那則留言的唯一編號，後端靠它認出是哪一則。

**建議刪除做成「標記作廢」而不是真的刪掉。** 多人同時操作時，真刪會讓後面的
資料位移，改到別人的留言——這是我們在 Google Sheets 上踩過的坑。

### JS API

```js
markoff.onSubmit = async (payload) => { … }  // 留言送去哪，見上方
markoff.comments                             // 目前所有留言（唯讀）
markoff.export()                             // 手動觸發匯出 JSON
markoff.retry()                              // 把送失敗的重送一次
```

## 送不出去的時候

留言不會遺失。pin 的樣子表示同步狀態：

| 樣子 | 意思 |
|---|---|
| 實心 | 已送達（純本機模式下按完留言就是這樣） |
| 空心＋轉圈 | 正在送 |
| 空心不轉 | 送失敗，等重試 |
| 灰色 | 元素目前不在頁面上（輪播換頁、動態內容），位置僅供參考 |

三個時機會自動重試：網路恢復、分頁切回前景、重新載入頁面。
連三輪失敗才會問要不要下載 JSON 備份。

## 目前的限制

- **各標各的**：標註只存在自己的瀏覽器，看不到別人標了什麼。要互看得自己做讀取端
- **只改得動自己這台電腦標的**：換一台電腦、或清掉瀏覽器資料，之前標的就找不回來改了
- **一次一頁**：標註按頁面路徑分開存，換頁再標是另一批
- **點擊會選到容器**：點在圖片或卡片的空白處時，可能選到外層容器而非你想指的那個元素。
  留言內容仍可讀，但選擇器會指得比較粗
- **同一則被兩人同時改**：後改的蓋掉先改的，不會提示

## 開發

沒有 build step，`src/markoff.js` 就是正本。

```bash
python3 -m http.server 8899
open http://localhost:8899/demo/index.html?comment=1
```

## License

MIT

---

Made by [果核概念 Coreplay](https://coreplay.tw) — 我們用它跟客戶與設計師校稿，
中文叫「網頁校稿標記工具」。
