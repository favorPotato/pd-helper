### **视频/图片解析通用规范**

**1. 输出要求**

只允许填充 `media_analysis` 对象内部字段，禁止修改其他字段。最终仅输出完整 JSON。

**2. media_analysis 字段定义**

- `description`: 1-2 句内容描述
- `per_image_notes`: 多图逐图备注，非多图写 `null`
- `visual_tags`: 3-6 个视觉标签
- `tone`: 内容调性
- `hook_points`: 2-4 个讨论锚点
- `text_in_image`: 画面文字，没有写 `null`
- `opening_hook`: 视频前 3 秒吸睛点，非视频写 `null`
- `turning_point`: 反转时刻，非视频写 `null`
- `highlight_moment`: 高光时刻，非视频写 `null`

**3. 质量要求**

语言简练、有张力，不套模板，紧扣画面本身与情绪氛围。
