//! 终端字符编码：把远端字节流按主机设置的编码（UTF-8 / GBK / GB18030 / GB2312 /
//! ISO-8859-1 / Big5）流式解码成文本，键盘输入再按同一编码编回字节。
//!
//! 流式很关键：一个多字节字符可能被拆在两个 SSH 数据包里，逐包 `from_utf8_lossy`
//! 会把它变成两个 `�`。解码器在包与包之间保留半个字符，等下一包补齐。

use encoding_rs::{Decoder, Encoding, UTF_8};

pub struct TermCodec {
    encoding: &'static Encoding,
    decoder: Decoder,
}

/// 把界面里的编码名映射到 encoding_rs。未知名字回落 UTF-8，并返回 false 告知调用方。
pub fn lookup(label: &str) -> (&'static Encoding, bool) {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return (UTF_8, true);
    }
    match Encoding::for_label(trimmed.as_bytes()) {
        Some(enc) => (enc, true),
        None => (UTF_8, false),
    }
}

impl TermCodec {
    pub fn new(label: &str) -> Self {
        let (encoding, _) = lookup(label);
        Self {
            encoding,
            decoder: encoding.new_decoder_without_bom_handling(),
        }
    }

    pub fn name(&self) -> &'static str {
        self.encoding.name()
    }

    /// 解码一段远端输出；不完整的尾部留到下一次
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        let cap = self
            .decoder
            .max_utf8_buffer_length(bytes.len())
            .unwrap_or(bytes.len() * 3 + 16);
        let mut out = String::with_capacity(cap);
        let (_, _, _) = self.decoder.decode_to_string(bytes, &mut out, false);
        out
    }

    /// 会话结束时冲掉解码器里残留的半个字符
    pub fn finish(&mut self) -> String {
        let mut out = String::with_capacity(16);
        let (_, _, _) = self.decoder.decode_to_string(b"", &mut out, true);
        out
    }

    /// 键盘输入 → 远端字节
    pub fn encode(&self, text: &str) -> Vec<u8> {
        if self.encoding == UTF_8 {
            return text.as_bytes().to_vec();
        }
        let (bytes, _, _) = self.encoding.encode(text);
        bytes.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_character_split_across_packets_is_kept_whole() {
        let mut codec = TermCodec::new("UTF-8");
        let bytes = "中文".as_bytes();
        let mut out = codec.decode(&bytes[..2]);
        out += &codec.decode(&bytes[2..4]);
        out += &codec.decode(&bytes[4..]);
        assert_eq!(out, "中文");
        assert!(!out.contains('\u{fffd}'));
    }

    #[test]
    fn gbk_round_trip_and_split() {
        let mut codec = TermCodec::new("GBK");
        let encoded = codec.encode("你好 ls");
        assert_eq!(&encoded[..4], &[0xc4, 0xe3, 0xba, 0xc3]);
        let mut out = codec.decode(&encoded[..1]);
        out += &codec.decode(&encoded[1..3]);
        out += &codec.decode(&encoded[3..]);
        assert_eq!(out, "你好 ls");
    }

    #[test]
    fn all_ui_encodings_are_known() {
        for label in ["UTF-8", "GBK", "GB18030", "GB2312", "ISO-8859-1", "Big5"] {
            assert!(lookup(label).1, "{label} 应能识别");
        }
        assert!(!lookup("klingon").1);
        assert_eq!(TermCodec::new("klingon").name(), "UTF-8");
    }

    #[test]
    fn big5_and_latin1_decode() {
        let mut big5 = TermCodec::new("Big5");
        assert_eq!(big5.decode(&[0xa4, 0xa4]), "中");
        let mut latin = TermCodec::new("ISO-8859-1");
        assert_eq!(latin.decode(&[0x63, 0x61, 0x66, 0xe9]), "café");
    }

    #[test]
    fn finish_flushes_dangling_bytes() {
        let mut codec = TermCodec::new("UTF-8");
        assert_eq!(codec.decode(&[0xe4, 0xb8]), "");
        assert_eq!(codec.finish(), "\u{fffd}");
    }
}
