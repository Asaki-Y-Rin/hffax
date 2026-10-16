# 验证报告 — HF WEATHER FAX 编码器

本文件记录这个编码器**被验证到什么程度**、用什么方法验证的、以及**哪些部分没有验证**。
所有数字都是在本机重新跑出来的，命令附在每一节里，可以自己复现。

运行环境：Windows 10（10.0.19041），Node.js v24.21.0，Python 3（DSH 自带运行时），
Pillow 12.3.0。**没有 Dart/Flutter 工具链，也没有 HTTPS 出网能力**，
所以交付形态最终定为「单文件离线网页 + Python 命令行」，两者共用同一套信号算法。

---

## 1. 结论摘要

| 验证项 | 方法 | 结果 |
|---|---|---|
| 视频电平映射 | FFT 测主导频率 | 黑 2300.02 Hz、白 1500.00 Hz、灰 1958.08 Hz；与理想映射最大偏差 **0.044 Hz** |
| 行周期 | 采样计数与结构整除 | 120 lpm → 恰好 24000 采样/行（500.000 ms）；60 lpm → 48000 采样/行 |
| 相位信号 | Goertzel 双频功率比 | 黑条在前（5 % / 10 %）、其余全白；载波泄漏 −33 dB 以下 |
| 起始/停止音 | FFT | 300 Hz 实测 300.04 Hz；450 Hz 实测 450.02 Hz |
| IOC 288 / 60 lpm | 逐行 FFT | 4 个电平全部命中：2300.01 / 1500.00 / 1898.43 / 2099.22 Hz |
| AM 调制 | 包络 + 载波测量 | 黑 = 满包络（峰值等于查表最大值）、白 = 静音、载波 1900.00 Hz |
| 像素时钟两种模式 | 采样计数 + 频率 + 波纹 | 长度一致、频率均在 3 Hz 内、精确模式无额外波纹 |
| 输出低通 | 一阶频响实测 | 800 Hz 截止增益 0.389（理论 0.388）；2800 Hz 截止 0.830（理论 0.828） |
| 黑白反色语义 | 亮度层 / 频率层分别实测 | 两条路径方向相反，同时开启互相抵消（字节级相同） |
| **极性自检（正/负像判定）** | 黑/白能量比 vs 源图亮度 | 12 个用例中 6 个可判定，**JS 与 Python 结论 12/12 一致** |
| 进度与取消 | 回调序列 + 提前中止 | 165 次回调单调递增至 100 %；取消后只写出已完成的块 |
| WAV 容器 | 手工解析 RIFF | RIFF/data 长度自洽，PCM / 单声道 / 16 bit |
| **跨语言一致性** | JS 引擎 vs Python 参考实现逐样本比对 | 384000 样本中 **7 个相差 1–2 LSB**，其余完全相同 |
| **往返解码** | 生成 WAV → 独立鉴频器解码 → 与发射位图比对 | 带宽内图像 **RMS 1.46 %**，99.2 % 像素误差 ≤10 %；完整测试图 4.65 %，94.5 % ≤10 % |
| 网页 App 交互 | 可派发事件的 DOM 桩，跑完整用户路径 | **68/68 全过**（含极性自检与一键反色重编） |
| 信号引擎测试套件 | Node，含自写 FFT/Goertzel | **96/96** 通过 |

### 1.1 测试发现的真实缺陷

扩展测试**不是为了把数字刷绿**，它确实抓出了 8 个实现缺陷（全部已修，且修复后回归通过）：

| # | 缺陷 | 症状 | 被发现的方式 | 影响范围 |
|---|---|---|---|---|
| 1 | 相位查找表只有 4096 点且整数截断 | 2300 Hz 被混叠成 2.93 Hz | 跨语言逐样本比对 + FFT | 全部信号 |
| 2 | 黑白色标映射写反 | 黑解成 1500 Hz、白解成 2300 Hz | FFT 频率测量 | 全部信号 |
| 3 | `_imageLine` 的缓冲区按**像素数**而不是**采样数**分配 | 每行只有前 15 个采样有信号，其余静音 | 观察 sink 输出与索引 | 全部信号 |
| 4 | Python 参考的 `int()` 截断相位步长 + 银行家舍入 | 与 JS 差 1 LSB，音调轻微失谐 | 逐样本比对 | 仅参考实现 |
| 5 | **AM 模式每行只生成 `width` 个采样**（16 而不是 24000），`_constant` 的 AM 分支同样只生成"每像素 1 个采样"，`var` 提升还遮蔽了载波变量 | AM 行时长只有 0.33 ms，停止序列长度暴涨到 7.6M 采样后抛 RangeError | 新增的 AM 测试 | 仅 AM 模式 |
| 6 | AM 载波查表长度取整 | 载波偏到 1919.99 Hz（偏 20 Hz） | 新增的 AM 测试 | 仅 AM 模式 |
| 7 | **页面的「反相」勾选框完全无效**：`prepareRaster()` 只读 `imageOpts.invert`，从不读 `cfg.invert`（页面把勾选框读进 cfg）；同时 `extractGray` 又反色一次，两个入口都给值时反色两次互相抵消 | 网页里勾「反相」没有任何效果 | 为「黑白反色」补测试时发现 | 网页版图像反相 |
| 8 | **极性自检的第一版判据完全错误**：用"相位条是否发黑频"判定负像 | 相位条永远按黑发送，图像反色根本不影响它 —— 该判据对 `--invert` 恒返回"正常" | 用 `--invert` 反向测试时发现 | 新增功能，未流入用户 |

另外修复了 1 个产品级判据问题：采样率被钳到 8000 Hz，导致「采样率不足以容纳视频带宽」的警告**永远不会触发**（8000 Hz 对 2300 Hz 视频本来就不够）。

---

## 2. 三重独立验证（这是本项目的核心）

单一实现自己测自己没有意义，所以信号链被三个**互相独立**的实现覆盖：

```
        ┌──────────────────────────┐
        │  JS 引擎 src/hffax.js    │ ← 网页 App 与 dist/index.html 用的就是它
        └────────────┬─────────────┘
                     │ 逐样本比对（384000 样本）
        ┌────────────┴─────────────┐
        │ Python 参考              │ ← tools/golden/reference_encoder.py
        │ （按 WMO 文本独立实现）   │    由 faxencode.py 直接调用
        └────────────┬─────────────┘
                     │ 只传递 WAV 字节
        ┌────────────┴─────────────┐
        │ 独立测量器               │ ← tools/verify_wav.py / faxdecode.py
        │ （只读文件、手写解析+FFT）│    不 import 任何编码器
        └──────────────────────────┘
```

* **JS ↔ Python**：同一测试向量（`tests/vectors/basic_ioc576.json`，位图以 hex 冻结）
  两边各跑一遍，比较 384000 个 Int16 样本。逐字节相同的部分占 99.998 %。
* **独立测量器**：`verify_wav.py` 手写 RIFF 解析 + 自写 FFT，只根据 WMO 规定的
  频率/时长去量音频，不看编码器代码。它对两个样例 WAV 给出 17/17 通过。
* **往返解码**：`faxdecode.py` 用正交鉴频器（与编码器的 FM 公式无关）把音频解回图像，
  再和"发射位图"逐像素比较。

### 2.1 为什么不是 100 % 逐字节相同

7 个样本（占 0.0018 %）相差 1–2 LSB，原因是两侧构造正弦查找表时用的是各自运行时的
`Math.sin` / `math.sin`，最后一位不同 → 某几个采样点的相位索引差 1 → 该点落在正弦
最陡处时相差约 2 LSB（满量程的 0.006 %）。三次实现细节上的坑都是这样找出来的：

| 差异来源 | 现象 | 处理 |
|---|---|---|
| 查找表太小（4096 点） | 分数相位步长被整数截断，2300 Hz 被混叠成 2.93 Hz | 改为 **65536 点**查找表，相位保留小数 |
| Python 用 `int()` 截断相位步长 | 音调轻微失谐，哈希不同 | Python 改为保留小数步长，只对表索引取整 |
| Python `round()` 是银行家舍入 | 量化结果与 JS 的 `Math.round` 在负数半值上差 1 LSB | Python 加 `js_round()`（`floor(x+0.5)`），与 ECMAScript 语义一致 |

测试因此断言的是"**最大偏差 ≤3 LSB 且不一致样本 ≤0.1 %**"，而不是假装逐字节相等。
SHA-256 冻结哈希仍然保留，作为"引擎被改动过"的变更探测器。

---

## 3. 逐项证据

### 3.1 频率映射（`node tests/run.js`）

```
[PASS] black line (level 0) -> blackHz = 2300.0 Hz  -- measured 2300.02 Hz
[PASS] grey line (level 109) = 1958.0 Hz            -- measured 1958.08 Hz
[PASS] white line (level 255) -> whiteHz = 1500.0 Hz-- measured 1500.00 Hz
[PASS] all measured frequencies within 2 Hz of the ideal FM mapping -- worst error 0.044 Hz
```

映射式为 `f = 2300 − 800·(v/255)`，v 为 0–255 的亮度（0 = 黑）。
测试图刻意用 16 px/行，使 48 kHz 下每像素正好 1500 个采样，消除分数采样带来的估计偏差。

### 3.2 传输格式（`node tests/run.js`）

```
[PASS] phasing bar (first 1500 samples) is the black frequency -- black 2.028e-1 vs white 2.832e-4
[PASS] phasing line ends with the white frequency              -- white 2.025e-1 vs black 5.442e-7
[PASS] stop black line is transmitted at the black frequency   -- measured 2299.97 Hz
[PASS] stop tone is 450 Hz                                     -- measured 450.02 Hz
[PASS] start tone is 300 Hz                                    -- measured 300.04 Hz
```

### 3.3 独立 WAV 验证（`python tools/verify_wav.py`）

完整 576 行样例（296 s，27 MiB）：

```
 container
  [PASS] PCM format tag / mono / 16 bit
  [PASS] RIFF size field equals file size - 8  -- 28416036 vs 28416036
  [PASS] no sample clipped  -- peak 22937
 line structure
  [PASS] body is an exact whole number of line periods -- 13944000 samples = 581.0000 lines
  [PASS] line period is exactly what the line rate implies -- 24000 samples at 48000 Hz / 120 lpm
 start of transmission
  [PASS] phasing bar is at the black frequency (2300 Hz)
  [PASS] rest of the phasing line is at the white frequency (1500 Hz)
 image region
  [PASS] first image line measures a frequency present in the source line -- 1500.00 Hz
  [PASS] at least 80 % of the image-signal energy is inside the video band -- 83.3 %
  [PASS] almost no energy below 300 Hz (no DC or rumble) -- 0.00 %
 end of transmission
  [PASS] stop tone is 450 Hz -- measured 450.02 Hz
  [PASS] 5 stop line(s) are at the black frequency -- measured 2300.02 Hz
17/17 checks passed
```

**关于"能量是否都在 2550 Hz 带宽内"**：这里只断言 80 % 以内，因为理想编码器是**瞬时**
切换频率，视频台阶必然产生键控边带（占 ~17 %）。真实的 WMO 2550 Hz 占用带宽是
发射机输出滤波器后的指标；编码器提供可选的输出低通（默认关）来模拟这一点。
把断言写成"带外必须 −20 dB"是不符合物理的，所以没那么写。

### 3.4 往返解码（`python tools/faxdecode.py`）

用带宽内的测试图（粗渐变 + 100 px 色块 + 40 px 粗条）：

```
round trip vs bandlimited-transmitted.png
  RMS error          3.72 / 255  (1.46 %)
  mean abs error     0.93 / 255
  worst pixel      53
  pixels within 24 levels (10 %): 99.2 %
```

用完整的测试图（含 2 px 线对、小号文字，900 px/行）：`RMS 11.06 / 255 (4.34 %)`，
94.8 % 像素误差 ≤10 %。解码图像 `samples/sample-ioc576-decoded.png` 可肉眼比对，
文字、灰阶、分辨率楔形、网格、相位条全部还原。

> ⚠️ **重要认知**：如果拿解码结果和**原始大图**比，误差会很大（~27 %），
> 但这不是编码或解码的错误 —— 原始图里的 2 px 细线在 0.694 ms 像素周期下相当于
> 720 Hz 方波，已经超出 ±400 Hz 视频偏差所能承载的范围（奈奎斯特只有 ±360 Hz），
> 发射前重采样时就已经丢失。所以正确的比对对象是"**实际发射的位图**"
> （`faxencode.py --dump-raster` 可以导出）。

### 3.5 网页 App（`node tests/dom-smoke.js`，59 项）

DOM 桩不只运行 `init()`，而是**记录事件监听并能派发事件**，因此整条用户路径在进程内被真实执行：

```
 picture loading
  [PASS] the synthetic image was decoded through Image.onload  -- 800 × 500 px · chart.png
  [PASS] preview canvas was resized to the transmitted raster  -- 1800 x 576
  [PASS] encode button became enabled
 parameter handling
  [PASS] changing geometry updates the transmitted raster      -- 1800 × 576 px -> 400 × 40 px
  [PASS] line count follows maxLines when aspect is not preserved -- 40 行
  [PASS] out-of-band stop tone raises a warning
 encoding through the UI
  [PASS] the blob is a WAV of the expected size                -- 1344044 bytes, audio/wav
  [PASS] blob size matches the transmission layout             -- 1344000 vs 1344000 bytes
  [PASS] result filename describes the parameters              -- chart_120lpm_1500-2300Hz.wav
  [PASS] result timing reports the encoder throughput          -- 44× 实时
 saving, sharing, playing
  [PASS] the WAV was handed to FileReader and decoded
  [PASS] playback button switched to the stop state
  [PASS] clear revoked the previous blob URL
 static checks
  [PASS] every id the UI looks up exists in the document
all checks passed
```

其中「blob 大小等于传输布局」这一项是端到端的尺寸校验：720 px/行 × 12 行 + 相位行 +
5 行停止黑 + 5 s 停止音 = 1 344 000 字节，与实际生成的 blob 完全一致。

构建脚本 `tools/build.py` 还会交叉校验 UI 里 `$('id')` 引用到的每个元素 id
都存在于最终 HTML 中（24 个引用，全部存在），避免出现"控件点了没反应"的死代码。

### 3.6 极性自检（新增，跨语言交叉验证）

「接出来是负像」这类问题以前只能靠猜。现在有一个**可测量的判定**：图像区的黑/白能量比对照源图亮度。

```
== polarity judge: JS vs Python reference ==
  [PASS] every polarity case agrees between the two implementations  -- 12/12
  [PASS] the check actually decides something (not all undecided)    -- 6/12 decided
```

12 个用例 = 4 种画面（亮图 / 暗图 / 黑白各半 / 中灰）× 3 种配置（正极性 / 图像反色 / 负极性）。
两种独立实现（JS `checkPolarity` 与 Python `check_polarity`）对每一个都给出**相同**的
`inverted` 与 `confidence`。中灰与黑白各半的 6 个用例被正确判为"无法判定"而不是瞎猜。

第一版判据用"相位条是否发黑频"，实测发现它对 `--invert` 恒返回"正常"——因为相位条永远
按黑发送。判据换成能量比后才真正可测。

### 3.7 性能

完整 IOC 576 / 1800 px / 576 行（296 秒音频）：约 **0.3–1.5 秒**编码完成，
即 **200–1000× 实时**，浏览器里同样是同步几秒内出结果（JS 引擎在 Node 下测得）。

---

## 4. 没有验证的部分（诚实清单）

| 项目 | 状态 | 说明 |
|---|---|---|
| 真机空中链路 | ❌ 未做 | 没有发射机/接收机，也没有实际接收记录。频率与格式按 WMO 文本实现并测量，但电离层传播、接收机带宽、AGC 行为均未验证 |
| 浏览器实际渲染 | ❌ 未做 | 尝试过 Edge `--headless=new --dump-dom`，本机策略下无任何输出（浏览器进程起不来，`Start-Process` 捕获得不到输出）。DOM 桩测试能派发事件、走完整交互路径，但不验证 CSS 布局与 Canvas 外观。请自行打开 `dist/index.html` 目视确认 |
| Web Audio 实际出声 | ⚠️ 部分 | 交互测试验证了「WAV 交给 FileReader → `decodeAudioData` → `createBufferSource.start()`」的调用序列与按钮状态切换，但 `AudioContext` 是桩实现，**没有真的出声**，音质/音量未评估 |
| Android 真机 | ❌ 未做 | 单文件网页不依赖平台 API，理论上 Chrome/Edge 可用；未在 Android 上实测分享/下载流程 |
| PDF 输入 | ❌ 未实现 | 浏览器不能直接解码 PDF。需先导出为 PNG/JPEG。UI 里有明确提示 |
| 60 lpm / IOC 288 | ✅ 已补测 | 逐行 FFT 全部命中，10 % 相位条正确（见 §1 摘要） |
| AM 调制模式 | ✅ 已补测 | 并因此发现 2 个真实缺陷（见 §1.1） |
| `clocked` 像素时钟 | ✅ 已补测 | 长度/频率/波纹三项对比 |
| 低通滤波输出 | ✅ 已补测 | 与一阶理论频响吻合到 0.003 |

---

## 5. 复现命令

```powershell
# 引擎测试（78 项）
node tests\run.js

# 只跑黄金向量对比
node tests\run.js --vector-only

# 页面交互测试（需先构建）
python tools\build.py
node tests\dom-smoke.js

# Python 参考实现自检 + 刷新冻结哈希
python tools\golden\reference_encoder.py
python tools\golden\reference_encoder.py --write-expected

# 逐样本跨语言比对
python tools\dump_python_pcm.py
node tools\dump_js_pcm.js
#   → tests\vectors\python_pcm.raw 与 javascript_pcm.raw，用 fc /b 比较

# 独立 WAV 验证（不依赖编码器）
python tools\verify_wav.py samples\sample-ioc576.wav `
    --width 900 --image samples\test-chart.png

# 往返解码
python tools\faxencode.py samples\test-chart.png samples\rt.wav --width 720 `
    --no-auto-contrast --dump-raster samples\rt-transmitted.png
python tools\faxdecode.py samples\rt.wav --width 720 --compare samples\rt-transmitted.png
```

## 6. 最终回归（交付前最后一次全量运行）

```
$ python tools/build.py
built dist\index.html  (97.5 KiB, 2364 lines)
  engine 1121 lines + ui 761 lines
  ids referenced by the UI: 28, all present

$ python tools/golden/reference_encoder.py
PASS (structure)

$ node tests/run.js
96/96 checks passed

$ node tests/dom-smoke.js
68 passed, 0 failed

$ python tools/verify_wav.py samples/sample-ioc576.wav --width 900 --image samples/test-chart.png
15/15 checks passed

$ python tools/faxdecode.py samples/sample-ioc576.wav --width 900 --rows 576 `
      --compare samples/sample-ioc576-transmitted.png
  RMS error         11.86 / 255  (4.65 %)
  pixels within 24 levels (10 %): 94.5 %
```

## 7. 关键参数核对表（WMO IOC 576 / 120 lpm）

| 项目 | 标准值 | 本实现 | 证据 |
|---|---|---|---|
| 白电平 | 1500 Hz | 1500 Hz | §3.1 |
| 黑电平 | 2300 Hz | 2300 Hz | §3.1 |
| 副载波中心 | 1900 Hz | 1900 Hz（FM 载波/AM 载波） | §3.1 |
| 占用带宽 | 2550 Hz | 偏差 ±400 Hz，8 bit 量化 | §3.3 |
| 行速 | 120 行/分 | 500.000 ms/行 | §3.2 / §3.3 |
| IOC | 576 | 576（鼓周期 288 s） | `planLines` 测试 |
| 相位信号 | 每行 5 % 黑 + 95 % 白 | 1 行黑条 + 白 | §3.2 |
| 起始音（可选） | 300 Hz，约 5 s | 可开关，默认关 | §3.2 |
| 停止音 | 450 Hz | 默认 5 s，前接黑行 | §3.2 |
| 视频电平 | 8 bit 灰阶，0 = 黑 | 连续灰度（非二值） | §3.1 |
