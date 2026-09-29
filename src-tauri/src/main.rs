// 发布构建下不弹出额外的控制台窗口（Windows）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    termx_lib::run()
}
