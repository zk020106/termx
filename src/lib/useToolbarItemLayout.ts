import { useCallback, useEffect, useMemo, useState } from "react";
import {
	moveToolbarItem,
	normalizeToolbarItemLayout,
	partitionToolbarItems,
	reorderToolbarItems,
	resetToolbarItemLayout,
	setToolbarItemPlacement,
	type ToolbarItemLayout,
	type ToolbarItemLayoutDefaults,
	type ToolbarItemPartition,
	type ToolbarItemPlacement,
} from "./toolbarItemLayout";

/* 移植自 Netcatty application/state/useToolbarItemLayout.ts。
 * Netcatty 存在 localStorageAdapter（同样是 localStorage + 跨窗口同步事件），这里直接用 localStorage + storage 事件。 */

const CHANGED_EVENT = "termx:toolbar-layout-changed";

function readLayout(storageKey: string, defaults: ToolbarItemLayoutDefaults): ToolbarItemLayout {
	try {
		const raw = localStorage.getItem(storageKey);
		return normalizeToolbarItemLayout(raw ? JSON.parse(raw) : null, defaults);
	} catch {
		return resetToolbarItemLayout(defaults);
	}
}

function writeLayout(storageKey: string, layout: ToolbarItemLayout): void {
	try {
		localStorage.setItem(storageKey, JSON.stringify(layout));
		window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { key: storageKey } }));
	} catch {
		// 尽力而为；内存里的状态本次运行仍然生效
	}
}

export function useToolbarItemLayout(storageKey: string, defaults: ToolbarItemLayoutDefaults) {
	const [layout, setLayout] = useState<ToolbarItemLayout>(() => readLayout(storageKey, defaults));

	useEffect(() => {
		const sync = (event: Event) => {
			if (event instanceof StorageEvent && event.key !== storageKey) return;
			if (event instanceof CustomEvent && event.detail?.key !== storageKey) return;
			setLayout(readLayout(storageKey, defaults));
		};
		window.addEventListener("storage", sync);
		window.addEventListener(CHANGED_EVENT, sync);
		return () => {
			window.removeEventListener("storage", sync);
			window.removeEventListener(CHANGED_EVENT, sync);
		};
	}, [defaults, storageKey]);

	const setPlacement = useCallback(
		(id: string, placement: ToolbarItemPlacement, availableIds?: readonly string[] | ReadonlySet<string> | null) => {
			const next = setToolbarItemPlacement(readLayout(storageKey, defaults), id, placement, defaults, availableIds);
			setLayout(next);
			writeLayout(storageKey, next);
			return next;
		},
		[defaults, storageKey],
	);
	const reorder = useCallback(
		(draggedId: string, targetId: string, placement: "before" | "after" = "before") => {
			const next = reorderToolbarItems(readLayout(storageKey, defaults), draggedId, targetId, placement);
			setLayout(next);
			writeLayout(storageKey, next);
		},
		[defaults, storageKey],
	);
	const move = useCallback(
		(id: string, direction: "earlier" | "later", availableIds?: readonly string[] | ReadonlySet<string> | null) => {
			const next = moveToolbarItem(readLayout(storageKey, defaults), id, direction, availableIds);
			setLayout(next);
			writeLayout(storageKey, next);
		},
		[defaults, storageKey],
	);
	const reset = useCallback(() => {
		const next = resetToolbarItemLayout(defaults);
		setLayout(next);
		writeLayout(storageKey, next);
	}, [defaults, storageKey]);
	const partition = useCallback(
		(availableIds?: readonly string[] | ReadonlySet<string>): ToolbarItemPartition => partitionToolbarItems(layout, availableIds),
		[layout],
	);
	return useMemo(() => ({ layout, partition, setPlacement, reorder, move, reset }), [layout, partition, setPlacement, reorder, move, reset]);
}
