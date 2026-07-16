import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import styles from './OverlayScrollArea.module.scss';

type Props = {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  dataViewScroll?: boolean;
};

type DragState = {
  pointerId: number;
  startClientY: number;
  startScrollTop: number;
};

const MIN_THUMB_PX = 48;

export function OverlayScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
  dataViewScroll = false,
}: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const updateThumb = useCallback(() => {
    frameRef.current = null;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) return;

    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const visible = maxScrollTop > 1 && track.clientHeight > 0;
    track.dataset.visible = visible ? 'true' : 'false';
    if (!visible) return;

    const thumbHeight = Math.min(
      track.clientHeight,
      Math.max(MIN_THUMB_PX, track.clientHeight * (viewport.clientHeight / viewport.scrollHeight)),
    );
    const maxThumbTop = track.clientHeight - thumbHeight;
    const thumbTop = maxThumbTop * (viewport.scrollTop / maxScrollTop);

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, []);

  const scheduleUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(updateThumb);
  }, [updateThumb]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return undefined;

    viewport.addEventListener('scroll', scheduleUpdate, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    scheduleUpdate();

    return () => {
      viewport.removeEventListener('scroll', scheduleUpdate);
      resizeObserver.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [scheduleUpdate]);

  function handleTrackPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) return;

    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const maxThumbTop = track.clientHeight - thumb.offsetHeight;
    if (maxScrollTop <= 0 || maxThumbTop <= 0) return;

    const clickY = event.clientY - track.getBoundingClientRect().top;
    const targetThumbTop = Math.max(0, Math.min(maxThumbTop, clickY - thumb.offsetHeight / 2));
    viewport.scrollTop = (targetThumbTop / maxThumbTop) * maxScrollTop;
  }

  function handleThumbPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startScrollTop: viewport.scrollTop,
    };
  }

  function handleThumbPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !viewport || !track || !thumb) return;

    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const maxThumbTop = track.clientHeight - thumb.offsetHeight;
    if (maxScrollTop <= 0 || maxThumbTop <= 0) return;
    viewport.scrollTop = drag.startScrollTop
      + ((event.clientY - drag.startClientY) / maxThumbTop) * maxScrollTop;
  }

  function handleThumbPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className={`${styles.root}${className ? ` ${className}` : ''}`}>
      <div
        ref={viewportRef}
        className={`${styles.viewport}${viewportClassName ? ` ${viewportClassName}` : ''}`}
        {...(dataViewScroll ? { 'data-view-scroll': true } : {})}
      >
        <div ref={contentRef} className={`${styles.content}${contentClassName ? ` ${contentClassName}` : ''}`}>
          {children}
        </div>
      </div>
      <div ref={trackRef} className={styles.track} onPointerDown={handleTrackPointerDown}>
        <div
          ref={thumbRef}
          className={styles.thumb}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={handleThumbPointerUp}
          onPointerCancel={handleThumbPointerUp}
        />
      </div>
    </div>
  );
}
