# DESIGN.md

## 1. Nguyên tắc

1. **Vuông, phẳng, 1px.** `border-radius: 0` cho input, chip, card, nút. Phân tách bằng
 `1px solid var(--z-line)`, không dùng shadow (trừ popover/menu nổi).
2. **Lưới "hairline".** Grid dùng `gap: 1px` trên nền `--z-line` để tạo đường kẻ giữa các ô
 thay cho border từng ô.
3. **Phân cấp bằng typography, không bằng màu.** Màu nhấn (`--z-accent` nâu hổ phách) chỉ dùng
 cho hover, từ khóa trong tiêu đề, tag, link trong văn bản.
4. **Bốn họ font, mỗi họ một vai trò:** display (tiêu đề), prose (đoạn văn), data (nhãn/UI),
 mono (định danh, số liệu kỹ thuật).
5. **Tương phản AAA.** Mọi màu chữ đạt ≥ 7:1 trên `--z-bg`.
6. **Chỉ light mode** (`color-scheme: light`).

## 2. Color tokens

```css
:root{
  color-scheme: light;
  --z-bg:#fafaf7;      /* nền trang, giấy ngà */
  --z-ink:#1a1a1a;     /* chữ chính            — 16.6:1 */
  --z-mute:#4a4843;    /* chữ phụ, nhãn        — 8.7:1  */
  --z-faint:#e7e5de;   /* nền hover, vùng nhạt */
  --z-line:#d4d1c7;    /* đường kẻ 1px         */
  --z-accent:#6b4400;  /* nhấn: hover, link, tag — 8.2:1 */
  --z-cmp:#3b536f;     /* màu so sánh/thứ cấp (xanh thép) — 7.6:1 */
  --z-brand:#ffc400;   /* vàng thương hiệu (nút CTA nền vàng) */
  --z-focus:#8a5a00;   /* outline focus */
  --z-code-bg:#f3f4f6; --z-code-line:#e2e4e8;
  --ok:#1e5c30;        /* 7.6:1 */
  --bad:#8f2427;       /* 8.2:1 */
  --warn:#5f4a0e;      /* 8.1:1 */
}
```


| Vai trò                                          | Giá trị                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Surface nổi (box, bảng, popover)                 | `#fff`                                                                                 |
| Input border mạnh                                | `#8c8a82`                                                                              |
| CTA gradient                                     | `linear-gradient(100deg,#6d28d9,#9333ea,#7c3aed,#6d28d9)`, `background-size:280% 100%` |
| Chart bar                                        | tổng `#c4b5fd`, unique `#6d28d9`                                                       |
| Tint pastel (treemap, hàng bảng xoay vòng 6 màu) | `#fff1c7` `#ebe4f7` `#dfebf5` `#e2f0e4` `#f7e6de` `#eeebe3`                            |
| Nền segmented control / filter bar               | `#eeebe3` / `#e7e5de`                                                                  |


## 3. Typography

Google Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@400;700;800;900&family=Inter:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

```css
--font-display:'Big Shoulders Display','Inter',system-ui,sans-serif; /* hero, h2, số liệu lớn */
--font-prose:'Inter',system-ui,sans-serif;                           /* body, lead */
--font-data:'IBM Plex Sans','Inter',system-ui,sans-serif;            /* nav, nhãn, nút, th */
--font-mono:'JetBrains Mono','IBM Plex Mono',monospace;              /* tên định danh, code, meta */
```

Thang cỡ (tên token là cỡ "danh nghĩa", giá trị thực đã được nâng lên):


| Token      | Giá trị            | Dùng cho                            |
| ---------- | ------------------ | ----------------------------------- |
| `--fs-11`  | 12px               | kicker, nhãn uppercase, badge, meta |
| `--fs-13`  | 14px               | chữ phụ, bảng, nút, code            |
| `--fs-16`  | 18px (17px ≤720px) | body                                |
| `--fs-20`  | 20px               | lead, label node                    |
| `--fs-32`  | 32px               | số liệu stat, h2 trang chi tiết     |
| `--fs-56`  | 56px               | h2 section (`.scene`)               |
| `--fs-96`  | 96px               | hero h1, từ domain khổng lồ         |
| `--fs-160` | 160px              | dự phòng                            |


Letter-spacing: `--track-ui: .14em` (nav, nút, kicker), `--track-label: .08em` (chip, th, badge).

Công thức các kiểu chữ:


| Kiểu              | Định nghĩa                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Hero h1           | display 900, `clamp(40px,6vw,96px)`, `line-height:.9`, `letter-spacing:-.02em`; từ nhấn dùng `--z-accent` |
| Section h2        | display 900, 56px, `line-height:.95`                                                                      |
| Domain word       | display 900, `clamp(40px,6vw,96px)`, UPPERCASE, `line-height:.92`                                         |
| Detail h2         | display 700, 32px, gạch dưới 1px `--z-line`                                                               |
| Lead              | prose, 20px, `line-height:1.5`, `--z-mute`, `max-width:56ch`                                              |
| Body              | prose 18px, `line-height:1.6`, `--z-ink`                                                                  |
| Kicker / UI label | data 500–600, 12px, UPPERCASE, `.14em`, `--z-mute`                                                        |
| Stat number       | display 800, 32px, `line-height:1`                                                                        |
| Identifier        | mono 600, 14px                                                                                            |


## 4. Spacing &amp; layout

```css
--sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px;
--sp-8:32px; --sp-10:48px; --sp-12:64px; --sp-16:96px;
--page-x:64px;   /* gutter ngang; 18px khi ≤900px */
--max-w:1680px;  /* main */
```

- `main { max-width:var(--max-w); margin:0 auto; padding:32px var(--page-x) 96px }`.
- Trang hẹp hơn: hồ sơ `1180px`, trang chi tiết repo `1080px`, search `46rem`, văn bản đọc `72ch`.
- Breakpoints: `900px` (gutter 18px, grid domain thành 1 cột), `760/720px` (xếp dọc, body 17px),
`600px` (bảng cuộn ngang), `420px`. Dùng thêm container queries (`680px`, `1040px`) cho treemap/bảng.

## 5. Components

**Nav** — sticky, nền `--z-bg`, `border-bottom:1px`, padding `16px var(--page-x)`;
chữ data 600, 12px, UPPERCASE, `.14em`, màu `--z-mute` → hover `--z-ink`.
Brand: display 900, 18px, `letter-spacing:.24em`, phần `<b>` màu accent. Có `.spacer{flex:1}`.

**CTA chính** — data 600, 14px, UPPERCASE, `.14em`, chữ trắng, nền gradient tím chạy
(`animation: ctaflow 5s ease infinite`), padding `.72em 1.25em`, không border, hover `brightness(1.12)`.

```css
@keyframes ctaflow{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
```

Nav CTA: lúc nghỉ chỉ là khung 1px `--z-line` chữ mute; bật gradient (`.on`) khi hero CTA cuộn khuất.

**CTA vàng** (`.cta1`) — nền `--z-brand`, chữ `--z-ink`, `700 16px` data, UPPERCASE, padding `18px 28px`.
**Nút phụ** — 1px `--z-ink` viền, nền trong suốt/trắng; hover đảo thành nền `--z-ink` chữ trắng.

**Chip / filter** — data 500, 12px, UPPERCASE, `.08em`, 1px `--z-line`, padding `.35em .9em`;
hover viền/chữ `--z-ink`; `.on` nền `--z-ink` chữ `--z-bg`. Biến thể trạng thái: viền+chữ `--ok`/`--warn`/`--z-cmp`.

**Badge** — mono 12px, 1px viền, padding `.1em .5em`; `.cat` accent, `.ok` xanh, `.bad` đỏ, `.mute` viền dashed.

**Input** — prose 14px, padding `.5em .8em`, 1px `#8c8a82`, nền trong suốt, radius 0;
focus `outline:3px solid --z-focus; outline-offset:1px; border-color:--z-accent`.

**Card grid** — `grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:1px; background:--z-line; border:1px solid --z-line`. Card nền `--z-bg`, padding 16px, hover `--z-faint`.
Nội dung: tên mono 600 14px, repo mono 12px mute, mô tả 14px mute, tag mono accent, chấm trạng thái tròn `.65em`.

**Stat grid** — 2 cột, hairline 1px; ô `min-height:88px`, padding `16px 20px`; số display 800 32px,
nhãn kicker. Hover số → accent.

**Domain row** (điểm nhấn trang chủ) — grid `110px 1fr auto 40px`, `border-top:1px`;
số đếm mono 20px, từ khổng lồ display 900 UPPERCASE, info căn phải, mũi tên mono; hover từ + mũi tên → accent.

**Treemap** — nhóm xếp dọc gap 1px; ô tuyệt đối `box-shadow: inset 0 0 0 1px --z-line`, padding 12px,
hover nền `--z-faint`; tiêu đề nhóm display 900 `clamp(32px,4vw,56px)`.

**Schema / flow nodes** — các node viền 1px, nối bằng mũi tên display 900 màu accent ở pseudo-element;
node active: `border-color` + `inset 0 0 0 1px` accent. ≤720px chuyển thành cột dọc, mũi tên ↓/↑.

**Bảng** — 14px prose, `border-bottom:1px` mỗi hàng, padding `.45em .6em`;
`th` data 600 12px UPPERCASE `.08em` mute. Biến thể "tint": `border-spacing:0 2px`, nền hàng xoay vòng 6 tint pastel.

**Segmented control** (ngoại lệ bo tròn duy nhất) — nền `#eeebe3`, `border-radius:999px`, padding 3px;
nút cao 40px, hover nền trắng, `aria-pressed=true` nền `--z-ink` chữ trắng.

**Box nổi** (`.kbox`, `.promptbox`, `.rpbox`) — 1px viền, nền `#fff`, padding `16–24px`.
Quote/trạng thái: `border-left:3px` (`--ok`/`--bad`/`--z-line`).

**Popover/menu** — nền `#fff`, 1px viền, `box-shadow:0 6px 24px rgba(0,0,0,.06)`–`0 8px 24px rgba(0,0,0,.08)`.
**Toast** — fixed góc dưới phải, nền `--z-ink`, chữ trắng, data 14px.

**Code inline** — mono `.9em`, nền `#f3f4f6`, viền 1px `#e2e4e8`, padding `.05em .35em`.

**Footer** — `border-top:1px`, chữ kiểu nav (data 500 12px UPPERCASE `.14em` mute), `gap:32px`.

**Avatar** — chỉ ảnh người mới tròn (`border-radius:50%`, viền 1px), 20–240px.

## 6. Interaction &amp; accessibility

- Link trong văn bản: màu accent, underline 1px, `text-underline-offset:.18em`; hover → `--z-ink`, underline 2px.
- Focus toàn cục: `:focus-visible{outline:3px solid var(--z-focus);outline-offset:2px}`.
- Placeholder dùng `--z-mute`, `opacity:1`.
- Transition ngắn (`.12s–.2s`) chỉ cho color/border/filter.
- Tôn trọng `prefers-reduced-motion` (tắt animation/transition).
- Số liệu dùng `font-variant-numeric: tabular-nums`; vùng tap tối thiểu 40–44px.

## 7. Do / Don't

- ✅ Kẻ 1px, góc vuông, nền ngà, chữ display lớn UPPERCASE cho tiêu đề và danh mục.
- ✅ Một điểm nhấn màu mỗi vùng; gradient tím chỉ cho CTA quan trọng nhất.
- ❌ Không bo góc card/nút/input, không shadow trên card, không dark mode.
- ❌ Không dùng accent làm nền diện rộng; không dùng màu trạng thái cho trang trí.