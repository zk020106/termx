"""生成 TermX 应用图标源图（1024x1024 PNG）。

用法：
    python tools/make-icon.py termx.vetd/../src-tauri/icon-source.png
之后由 `pnpm tauri icon <png>` 生成各平台尺寸。

图形：近黑圆角方块 + 靛蓝终端提示符（>_），与 theme.css 的 Linear 体系一致。
"""

import sys
from PIL import Image, ImageDraw

SIZE = 1024
BG = (13, 16, 21, 255)          # 对应 --tx-surface 附近的近黑
PRIMARY = (94, 106, 210, 255)   # 对应 --tx-primary（软靛蓝）
RING = (36, 40, 50, 255)        # 极细描边，深色底上界定边界


def main(out_path: str) -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角方块底
    draw.rounded_rectangle([(0, 0), (SIZE - 1, SIZE - 1)], radius=224, fill=BG, outline=RING, width=6)

    # 终端提示符：>
    chevron = [(356, 336), (508, 512), (356, 688)]
    draw.line(chevron, fill=PRIMARY, width=76, joint="curve")
    for point in (chevron[0], chevron[-1]):
        r = 38
        draw.ellipse([point[0] - r, point[1] - r, point[0] + r, point[1] + r], fill=PRIMARY)

    # 光标下划线：_
    draw.rounded_rectangle([(584, 612), (716, 688)], radius=38, fill=PRIMARY)

    img.save(out_path, "PNG")
    print(f"icon source written: {out_path}")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/icon-source.png"
    main(target)
