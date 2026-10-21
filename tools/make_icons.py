#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无第三方依赖）。"""
import struct, zlib, os

SIZE = 128
SS = 4  # 超采样倍数

C1 = (99, 102, 241)   # indigo
C2 = (139, 92, 246)   # violet
WHITE = (255, 255, 255)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def in_rrect(x, y, x0, y0, x1, y1, r):
    cx = clamp(x, x0 + r, x1 - r)
    cy = clamp(y, y0 + r, y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_tri(p, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign(p, a, b)
    d2 = sign(p, b, c)
    d3 = sign(p, c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def gradient(t):
    return tuple(round(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))


def sample(x, y):
    """返回 (r,g,b,a)，坐标归一化到 0..1"""
    if not in_rrect(x, y, 0.02, 0.02, 0.98, 0.98, 0.23):
        return (0, 0, 0, 0)

    bg = gradient((x + y) / 2.0)
    col = bg

    # 双语文案气泡
    if in_rrect(x, y, 0.17, 0.19, 0.83, 0.64, 0.11):
        col = WHITE
    elif in_tri((x, y), (0.33, 0.62), (0.27, 0.83), (0.52, 0.62)):
        col = WHITE

    # 气泡里的两行“文字”
    if in_rrect(x, y, 0.27, 0.30, 0.73, 0.355, 0.0275):
        col = C1
    if in_rrect(x, y, 0.27, 0.44, 0.61, 0.495, 0.0275):
        col = C2

    return (col[0], col[1], col[2], 255)


def render(size):
    out = bytearray()
    step = 1.0 / (size * SS)
    for py in range(size):
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * step
                    y = (py * SS + sy + 0.5) * step
                    sr, sg, sb, sa = sample(x, y)
                    w = sa / 255.0
                    r += sr * w
                    g += sg * w
                    b += sb * w
                    a += sa
            n = SS * SS
            a /= n
            if a <= 1e-6:
                out += bytes((0, 0, 0, 0))
            else:
                wa = a / 255.0
                out += bytes((
                    int(round(r / n / wa)),
                    int(round(g / n / wa)),
                    int(round(b / n / wa)),
                    int(round(a)),
                ))
    return bytes(out)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(os.path.dirname(here), "icons")
    os.makedirs(icons_dir, exist_ok=True)

    master = render(SIZE)
    for s in (16, 32, 48, 128):
        if s == SIZE:
            data = master
        else:
            # 最近邻缩小 + 简单盒式平均
            k = SIZE // s
            buf = bytearray()
            for y in range(s):
                for x in range(s):
                    acc = [0, 0, 0, 0]
                    for dy in range(k):
                        for dx in range(k):
                            i = ((y * k + dy) * SIZE + (x * k + dx)) * 4
                            for c in range(4):
                                acc[c] += master[i + c]
                    n = k * k
                    buf += bytes((acc[0] // n, acc[1] // n, acc[2] // n, acc[3] // n))
            data = bytes(buf)
        write_png(os.path.join(icons_dir, "icon%d.png" % s), s, data)
        print("wrote icons/icon%d.png" % s)
