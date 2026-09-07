### Feature: Home composer vertical alignment matches reference layout

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open the `New thread` (home) screen with a selected folder/project.
- Ensure desktop viewport width (for example >= 1280px).

#### Steps
1. Open the home screen and observe the hero block (`Let's build`) and composer placement.
2. Confirm the hero/settings block is vertically centered within the available content area.
3. Confirm the message composer sits in the lower area of the content column (not immediately below top content).
4. Resize window height taller/shorter and re-check vertical placement.
5. Open any thread route and verify thread composer layout remains unchanged.

#### Expected Results
- Home hero block is centered again (not top-anchored).
- Home composer aligns toward the bottom region similar to the reference screenshot.
- Resizing preserves the intended centered-hero + lower-composer structure.
- Thread route composer behavior is unchanged.

#### Rollback/Cleanup
- Revert the `.new-thread-empty` style in [src/App.vue](../../src/App.vue).

#### 2026-09-07 手机短窗口补充
- 高度充足时仍居中；内容超出可用高度时从顶部开始，在输入框上方独立滚动，不通过压缩图标或让按钮溢出维持居中。
- 具体尺寸、文字放大、多行草稿与点击验证见 [iOS 页面回归](ios-interface-and-scrollbars.md#手机首页高度不足与项目按钮遮挡回归)。
