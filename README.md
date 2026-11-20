# Repro

Repro turns browser captures into cropped recordings and annotated screenshots for bug reports, test evidence, and short demonstrations. It works alongside the agent’s existing browser controls.

Tell your agent which capture method you prefer. A request for the current task takes precedence over a standing preference. With no preference, the agent uses the current browser’s built-in capture when it can save the requested media to files Repro can access. Otherwise, the agent uses the Chrome extension. See [browser capture workflows](docs/reference.md#browser-capture-workflows).

## Examples

Captured with Repro on the included demo page. Click an animation for the MP4.

**Cropped recordings with click indicators and idle time removed.** This 21-second session becomes a six-second clip.

[![Cropped recording with visible clicks and idle gaps removed](docs/media/cropped-interactions.gif)](docs/media/cropped-interactions.mp4)

**Keyboard actions stay readable.** Shortcuts and action keys appear in order; repeated keys become “Tab ×3.” Ordinary typing is omitted from the badge.

[![Keyboard badges showing Tab, Enter, Tab and repeated Tab presses](docs/media/keyboard-sequences.gif)](docs/media/keyboard-sequences.mp4)

**Pause on something worth inspecting.** The agent adds a labelled box and a reading pause to the final video, then carries on working.

[![A labelled result held for three seconds before the next action](docs/media/reading-pause.gif)](docs/media/reading-pause.mp4)

**Screenshots with boxes, arrows, and labels.** Target a page element or choose a region.

![Cropped screenshot with a labelled box and arrow](docs/media/annotated-screenshot.png)

**Capture just the relevant part.** Labels move into a legend when the crop is too tight.

![Tightly cropped buttons with a numbered label legend](docs/media/compact-labels.png)

![A screenshot cropped to only the result message](docs/media/cropped-screenshot.png)

Multiple agents can record separate tabs at the same time. Files are saved locally as MP4 videos and PNG screenshots; the original recording is kept too.

## Install

The managed install requires macOS, Codex, Node 22+, and FFmpeg. With Homebrew, install missing dependencies using `brew install node ffmpeg`.

```sh
git clone https://github.com/rmessenger/repro.git
cd repro
npm ci && npm run install:local
```

Keep this folder in place. The installer configures Codex and starts the local service automatically.

For the extension workflow, use Chrome 116+ and follow these steps.

1. In Chrome, open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repo’s **dist/extension** folder.
3. Accept website access if prompted, then pin **Repro** from the Extensions menu.

Restart Codex to load the tools for either workflow.

## Use

Ask your agent, for example:

> Record me publishing a post. Capture only the publish panel, pause on the result with a label, and save an annotated screenshot.

When using the Chrome extension, the agent selects the tab and requests capture. When the banner appears, click the pinned **REC?** extension icon once. The agent continues automatically. That tab stays approved for later clips and screenshots. Each recording starts and stops separately.

[Updates, troubleshooting, limitations, and developer reference](docs/reference.md)

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
