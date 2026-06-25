import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	STAGGER_THRESHOLD,
	computeConcurrency,
	type LoadPhase,
	markLoaded as markLoadedPure,
	reconcile,
	shouldMount as shouldMountPure,
} from "./staggerLoad";

/** Drives which TV thumbnails are mounted: a concurrency-bounded load queue fed
 *  by an IntersectionObserver on the scroll container. Below STAGGER_THRESHOLD
 *  channels it mounts everything; above it, only visible thumbnails load, ≤ K at
 *  a time, freeing a slot on each onReady.
 *
 *  Every state change goes through setPhase from an *event* (intersection,
 *  markLoaded, or a list/priority/budget change) — never from a render — so
 *  there is no reconcile-on-every-render feedback loop. "Promote the next
 *  queued thumbnail" is folded into the same setPhase as markLoaded.
 *
 *  `rootRef` must be a STABLE ref (e.g. from useRef), not recreated per render,
 *  since the observer effect keys on it. */
export function useStaggeredLoad(opts: {
	ids: number[];
	priorityIds: number[];
	rootRef: React.RefObject<HTMLElement | null>;
}): {
	shouldMount: (id: number) => boolean;
	markLoaded: (id: number) => void;
	observe: (id: number, el: HTMLElement | null) => void; // ref callback per thumbnail
} {
	const { ids, priorityIds, rootRef } = opts;
	const [phase, setPhase] = useState<Map<number, LoadPhase>>(new Map());

	const small = ids.length <= STAGGER_THRESHOLD;
	const concurrency = small ? ids.length : computeConcurrency(ids.length);

	// Stable mirror of the inputs so the event callbacks keep a fixed identity
	// yet always read current values (no stale closures, no churn).
	const cfg = useRef({ ids, priorityIds, concurrency, small });
	cfg.current = { ids, priorityIds, concurrency, small };

	// id <-> element bookkeeping for the observer and visibility set.
	const elToId = useRef<Map<Element, number>>(new Map());
	const idToEl = useRef<Map<number, HTMLElement>>(new Map());
	const visible = useRef<Set<number>>(new Set());
	const observerRef = useRef<IntersectionObserver | null>(null);

	// Pure: recompute phases from a base map + current visibility/priority/budget.
	const recompute = useCallback((base: Map<number, LoadPhase>) => {
		const { ids, priorityIds, concurrency, small } = cfg.current;
		const visibleIds = small ? ids : ids.filter((id) => visible.current.has(id));
		return reconcile(base, { visibleIds, priorityIds, concurrency });
	}, []);

	// Build the observer once per root (and when crossing the stagger threshold);
	// each intersection change re-reconciles.
	useEffect(() => {
		if (small) {
			setPhase((prev) => recompute(prev));
			return;
		}
		const obs = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = elToId.current.get(entry.target);
					if (id == null) continue;
					if (entry.isIntersecting) visible.current.add(id);
					else visible.current.delete(id);
				}
				setPhase((prev) => recompute(prev));
			},
			{ root: rootRef.current ?? null, rootMargin: "200px" },
		);
		observerRef.current = obs;
		for (const el of elToId.current.keys()) obs.observe(el);
		return () => {
			obs.disconnect();
			observerRef.current = null;
		};
	}, [rootRef, recompute, small]);

	const idsKey = ids.join(",");
	const priorityKey = priorityIds.join(",");
	// Re-reconcile when the channel list, priority, or budget changes. Keyed on
	// stable strings so it fires on real changes, not on every render.
	useEffect(() => {
		setPhase((prev) => recompute(prev));
	}, [idsKey, priorityKey, concurrency, recompute]);

	const observe = useCallback((id: number, el: HTMLElement | null) => {
		const prevEl = idToEl.current.get(id);
		if (prevEl && prevEl !== el) {
			observerRef.current?.unobserve(prevEl);
			elToId.current.delete(prevEl);
			visible.current.delete(id);
		}
		if (el) {
			idToEl.current.set(id, el);
			elToId.current.set(el, id);
			observerRef.current?.observe(el);
		} else {
			idToEl.current.delete(id);
			visible.current.delete(id);
		}
	}, []);

	// Mark loaded AND promote the next queued thumbnail in one update.
	const markLoaded = useCallback(
		(id: number) => setPhase((prev) => recompute(markLoadedPure(prev, id))),
		[recompute],
	);

	const shouldMount = useCallback(
		(id: number) => (cfg.current.small ? true : shouldMountPure(phase, id)),
		[phase],
	);

	return { shouldMount, markLoaded, observe };
}
