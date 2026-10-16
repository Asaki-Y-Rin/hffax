# HF WEATHER FAX 编码器

把一张图片编码成 **WMO/IMO 标准短波气象传真音频（WEFAX / radio facsimile）**，
输出 16-bit 单声道 PCM WAV，可以直接送去电台发射，或用传真解码软件回放验证。

两个运行时，共用同一套信号引擎：

| 形态 | 文件 | 运行方式 |
|---|---|---|
| **单文件离线网页 App** | `dist/index.html` | Windows/Mac/Linux 浏览器双击即用；Android 用 Chrome/Edge 打开，可“添加到主屏幕” |
| **命令行编码器** | `tools/faxencode.py` | 只要有 Python 3 + Pillow，无需 Node、无需构建 |

两者使用**完全相同**的信号代码：网页内联的引擎是 `src/hffax.js`，
命令行工具调用 `tools/golden/reference_encoder.py` 中的同一个编码器类，
而这两个实现已被逐样本交叉验证（见 `VERIFICATION.md`）。

---

## 30 秒上手

### Windows（网页版，推荐）

1. 双击 `dist\index.html`（或拖进浏览器窗口）。
2. 把你的天气图/图片拖到左上角虚线框里（也可以直接 `Ctrl+V` 粘贴截图）。
3. 什么参数都不用改 —— 默认就是 **IOC 576 / 120 lpm / 1500–2300 Hz**。
4. 点 **编码为 WAV** → 点 **保存 WAV**。
5. 用播放器把 WAV 从电台的数据口/话筒口送进 SSB 发射。

想先听一下效果：仓库里已经有两个现成文件 ——
`samples\test-chart-demo.wav`（720 px/行、12 行、7 秒、0.6 MiB，适合快速试听）
和 `samples\sample-ioc576.wav`（900 px/行、完整 576 行、289 秒、26 MiB）。
`samples\sample-ioc576-decoded-vs-source.png` 是「发射位图 vs 解码还原」的对比图。

### Android（网页版）

1. 把 `dist/index.html` 拷到手机（微信/QQ/数据线/网盘都行），用 Chrome 打开。
2. 或者放到任意静态服务器/网盘直链上，用手机浏览器访问。
3. 选图 → 编码 → 点 **分享到…**，可以直接把 WAV 发给电台软件、网盘、邮件。
   （桌面浏览器用 **保存 WAV**；Chrome 的“添加到主屏幕”可以当成本地 App 用。）

> 手机浏览器打开本地 `file://` 完全可用：整个应用不联网、无外部资源。

### 命令行（Windows，无需 Node）

```powershell
# 生成测试图并编码
python tools\faxencode.py --test-chart

# 编码自己的图片（保持长宽比，自动定行数）
python tools\faxencode.py chart.png out.wav

# 60 行/分、IOC 288、照片抖动、反相
python tools\faxencode.py photo.jpg --lpm 60 --ioc 288 --width 900 --dither bayer8 --invert

# 只要音频，别的都别动
python tools\faxencode.py weather.png
```

---

## 参数说明（界面里都能改）

| 参数 | 默认 | 说明 |
|---|---|---|
| 行速 LPM | 120 | 每分钟行数，标准只有 **60** 与 **120** |
| IOC 合作指数 | 576 | 一鼓行数；576 配 120 lpm（鼓周期 288 s），288 配 60 lpm |
| 每行像素数 | 1800 | 1800 px/行 = 3.75 ms/像素（经典 WMO 像素钟） |
| 最大行数 | 576 | 图像行数上限；勾选“保持长宽比”时按图片比例自动算 |
| 采样率 | 48000 | 11025 / 22050 / 44100 / 48000 都可用 |
| 白电平 / 黑电平 | 1500 / 2300 Hz | **正频移对应黑**（WMO）；可反相 |
| 调制方式 | FM | 1900 Hz 副载波 ±400 Hz；另提供 AM 供实验 |
| 相位信号 | 开，5 % 黑 | 接收机靠它锁定行的起点。IOC 288 标准用 10 % |
| 起始音 | 关 | 部分台站用 300 Hz（IOC 576）/ 675 Hz（IOC 288），5 s |
| 停止音 | 开，450 Hz，5 s | 后面跟 5 行全黑（WMO 用 5 % 黑） |
| 自动对比度 | 开 | 把扫描件/JPEG 的灰底拉成纯黑纯白，恢复对比度 |
| 抖动 | 无 | 天气图**不要**开抖动；照片用 Bayer 8×8 或 Floyd–Steinberg |
| 输出电平 | 0.7 | ≈ −3 dBFS。界面会报峰值和削顶采样数 |

### 发射设置（SSB）

| 项目 | 取值 |
|---|---|
| 模式 | USB（或 AM） |
| 20 m 段常用频点 | 14.230 MHz 附近；USB 拨号约 14.2281 MHz |
| 音频带宽 | 关掉语音压缩/降噪，带宽 ≥ 2.6 kHz |
| 驱动电平 | ALC 不起表，避免削顶（削顶会产生带外杂散） |

USB 发射时 1900 Hz 副载波落在 `拨号频率 + 1.9 kHz`；接收端用 fldigi、JWX、
HF-FAX 等软件把 SSB 音频解回图像。

---

## 接出来是「负像」（黑白反了）怎么办

先分清是哪一层反了 —— 软件里有两个独立开关，**作用在同一个方向上**：

| 开关 | 作用层 | 结果 |
|---|---|---|
| 图像处理 → **反相（底片/负像）** | 亮度映射 | 黑发 1500 Hz、白发 2300 Hz |
| 标准参数 → **黑白极性 = negative** | 频率映射 | 黑发 1500 Hz、白发 2300 Hz |

**两个都勾 = 抵消，回到原始正像**。所以只需要勾一个。

### 用软件先判定，别靠猜

网页版：编码完成后，结果区有 **「检查这段音频的极性」** —— 它直接测音频里图像区的黑/白能量比，结合源图亮度判定"正常接收机会不会画成负像"。
判定为负像时，点 **「反色并重编」** 一键修正（会翻转反相开关并重新编码）。

命令行：

```powershell
python tools\faxencode.py chart.png out.wav --sign
#   sign check :
#     image area black/white energy balance 0.1 %, dominant level 255/255, 8 line(s) measured
#     OK — the picture is transmitted as a positive image
#
python tools\faxencode.py chart.png out.wav --sign --invert
#     INVERTED — a normal receiver will show this as a NEGATIVE.
```

自检**不能**用相位条判定 —— 相位条永远按黑发送，图像反色不影响它（这是我第一版判据的错误）。

### 如果软件说"极性正常"，但接收端仍是负像

那问题在链路或接收端，按下列顺序排查：

1. **接收软件的图像反相 / 极性设置**被打开了（最常见）。fldigi、JWX、HF-FAX 一类程序里都有 `Invert` / `Negative` 开关，先关掉。
2. **边带选错或调谐偏了一个边带宽度**：USB 与 LSB 解出的视频极性相反。确认收发双方同为 USB（或同为 LSB）—— 或者干脆把接收端切成另一边带试试。
3. **接收机/发射机内部的边带或音频反相**（有些机器在数据模式下会反转音频相位）。把电台的 `Data mode` 前后设置、DSP 反相选项确认一遍。
4. **源图本身就是负像**（扫描仪/截图工具导出成了底片）。先在软件里勾一次「反相」，看预览位图是否变正常。
5. 排除了上面全部之后，**改用另一个开关再试**：只勾「黑白极性 = negative」而**不要**勾图像反相，看接收端是否变正。

> 判定依据：WMO 规定**正频移对应黑**（黑 = 2300 Hz，白 = 1500 Hz）。接收端按此还原即为正像。

---

## 仓库结构

```
dist/index.html                 ← 最终交付的单文件 App（由 tools/build.py 生成）
src/hffax.js                    ← 信号引擎：DDS/FM、相位、WAV、图像处理（浏览器+Node 通用）
src/app.js                      ← 网页 UI 逻辑
src/index.template.html         ← 页面模板（含两个拼接标记）
tools/build.py                  ← 把引擎与 UI 内联进单文件 HTML，并校验 id 一致性
tools/golden/reference_encoder.py  ← Python 独立参考实现（黄金模型）
tools/faxencode.py              ← 命令行编码器（图片 → WAV）
tools/faxdecode.py              ← 命令行解码器（WAV → PNG，含往返误差统计）
tools/verify_wav.py             ← 不依赖编码器的 WAV 独立验证（FFT/Goertzel）
tools/wavutil.py                ← 上述工具共用的 WAV/FFT 基础设施
tools/make_vectors.py           ← 重新生成测试向量里的位图
tools/dump_python_pcm.py        ← 导出参考实现 PCM，供跨语言逐样本比对
tools/dump_js_pcm.js            ← 导出 JS 引擎 PCM
tools/dump_polarity_cases.py    ← 生成极性判定用例，供两种实现交叉比对
tests/run.js                    ← Node 信号测试套件（96 项）
tests/dom-smoke.js              ← 可派发事件的 DOM 桩交互测试（59 项）
tests/vectors/                  ← 测试向量（含冻结哈希与 Python 参考 PCM）
samples/                        ← 测试图、样例 WAV、往返对比图
VERIFICATION.md                 ← 验证方法与结果（含未验证项）
快捷开始.cmd                    ← Windows 双击即用的入口
```

## 重新构建 / 重新验证

```powershell
python tools\build.py                                  # 重建 dist/index.html
python tools\golden\reference_encoder.py --write-expected   # 刷新黄金哈希
python tools\dump_python_pcm.py                        # 刷新逐样本参考 PCM
node tests\run.js                                      # 信号与容器测试（78 项）
node tests\dom-smoke.js                                # 页面交互测试（59 项）
python tools\verify_wav.py samples\sample-ioc576.wav `
       --width 900 --image samples\test-chart.png      # 独立验证 WAV（不依赖编码器）
python tools\faxdecode.py samples\sample-ioc576.wav --width 900 --rows 576 `
       --compare samples\sample-ioc576-transmitted.png # 往返解码（RMS 4.65 %）
```

需要 Node.js 与 Python 3（Pillow 仅用于图片 I/O）。本机没有 Dart/Flutter、
没有网络出口也能完整运行。

## 许可与合规

仅限持有相应业余无线电执照的操作者，以及气象传真爱好者做实验/自测使用。
发射前请确认本地法规、频率授权与发射功率限制。软件不保证接收端一定正确还原，
真机效果取决于传播条件、接收机带宽与频道占用情况。
