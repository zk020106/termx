import { create } from "zustand";
import {
	DEFAULT_DATA,
	DEFAULT_SECURITY,
	DEFAULT_TERMINAL,
	type DataPreferences,
	type LockVerifier,
	type Preferences,
	type SecurityPreferences,
	type TerminalPreferences,
} from "@/data/preferences";

/* =============================================================================
 * 设置项 store —— 设置页里所有「真的会生效」的偏好都住在这里。
 *
 * 写入即生效：组件直接订阅字段（xterm 的运行时选项、右键行为、钥匙串开关…）；
 * 持久化：store/persistence.ts 把 toPreferences() 的结果并进配置文件，改完写盘。
 * ========================================================================== */

interface SettingsState extends TerminalPreferences, Omit<SecurityPreferences, "lockVerifier"> {
	lockVerifier: LockVerifier | null;
	sshConfigPath: string;

	setTerminal: (patch: Partial<TerminalPreferences>) => void;
	setSecurity: (patch: Partial<SecurityPreferences>) => void;
	setSshConfigPath: (path: string) => void;
	/** 启动时用磁盘上的配置覆盖一遍（首帧就是用户选的那套） */
	hydrate: (preferences: Preferences) => void;
	toPreferences: () => { terminal: TerminalPreferences; security: SecurityPreferences; data: DataPreferences };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
	...DEFAULT_TERMINAL,
	...DEFAULT_SECURITY,
	sshConfigPath: DEFAULT_DATA.sshConfigPath,

	setTerminal: (patch) => set(patch),

	setSecurity: (patch) => set(patch),

	setSshConfigPath: (path) => set({ sshConfigPath: path }),

	hydrate: (preferences) =>
		set({
			...preferences.terminal,
			...preferences.security,
			sshConfigPath: preferences.data.sshConfigPath,
		}),

	toPreferences: () => {
		const state = get();
		return {
			terminal: {
				...pickTerminalExtras(state),
				fontFamily: state.fontFamily,
				fontSize: state.fontSize,
				lineHeight: state.lineHeight,
				scrollback: state.scrollback,
				cursorStyle: state.cursorStyle,
				bell: state.bell,
				rightClick: state.rightClick,
				trimNewline: state.trimNewline,
				scheme: state.scheme,
				sftpFollowActiveTab: state.sftpFollowActiveTab,
				commandSuggestions: state.commandSuggestions,
				ghostText: state.ghostText,
			},
			security: {
				keychain: state.keychain,
				clearClipboard: state.clearClipboard,
				autoLock: state.autoLock,
				startLocked: state.startLocked,
				lockVerifier: state.lockVerifier,
			},
			data: { sshConfigPath: state.sshConfigPath },
		};
	},
}));


/** 移植自 Netcatty 的终端行为字段：逐项抄出，不把 store 的函数带进配置文件 */
function pickTerminalExtras(state: TerminalPreferences) {
	return {
		middleClick: state.middleClick,
		showContextMenuOverFullscreenApps: state.showContextMenuOverFullscreenApps,
		copyOnSelect: state.copyOnSelect,
		cursorBlink: state.cursorBlink,
		drawBoldInBrightColors: state.drawBoldInBrightColors,
		fontWeight: state.fontWeight,
		fontWeightBold: state.fontWeightBold,
		minimumContrastRatio: state.minimumContrastRatio,
		altAsMeta: state.altAsMeta,
		wordSeparators: state.wordSeparators,
		smoothScrolling: state.smoothScrolling,
		scrollOnInput: state.scrollOnInput,
		disableBracketedPaste: state.disableBracketedPaste,
		autoUploadClipboardImageOnPaste: state.autoUploadClipboardImageOnPaste,
		clearWipesScrollback: state.clearWipesScrollback,
		keywordHighlightEnabled: state.keywordHighlightEnabled,
		keywordHighlightRules: state.keywordHighlightRules,
		tabDoubleClick: state.tabDoubleClick,
		hotkeyScheme: state.hotkeyScheme,
		customKeyBindings: state.customKeyBindings,
		disableTerminalFontZoom: state.disableTerminalFontZoom,
		sftpDoubleClickBehavior: state.sftpDoubleClickBehavior,
		sftpAutoSync: state.sftpAutoSync,
		sftpShowHiddenFiles: state.sftpShowHiddenFiles,
		sftpFollowTerminalCwd: state.sftpFollowTerminalCwd,
		sftpFileOpeners: state.sftpFileOpeners,
		sftpVisibleColumns: state.sftpVisibleColumns,
		sftpDirectoriesFirst: state.sftpDirectoriesFirst,
		sftpHostViewModes: state.sftpHostViewModes,
		customCss: state.customCss,
		uiFontFamily: state.uiFontFamily,
		sessionRestore: state.sessionRestore,
	};
}
