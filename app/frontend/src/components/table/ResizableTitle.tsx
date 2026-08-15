// 表头拖拽调列宽（2026-08-11，管理后台表格统一）——零依赖：mousedown/move/up 更新宽度
export function ResizableTitle(props: any) {
  const { onResize, width, ...rest } = props;
  if (!width) return <th {...rest} />;
  return (
    <th {...rest} style={{ position: 'relative', ...rest.style }}>
      {rest.children}
      <div
        onMouseDown={(e: React.MouseEvent) => {
          e.preventDefault(); e.stopPropagation();
          const startX = e.clientX;
          const startW = Number(width) || 80;
          const move = (ev: MouseEvent) => onResize(Math.max(60, startW + ev.clientX - startX));
          const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
          };
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
        }}
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize', userSelect: 'none', zIndex: 1 }}
      />
    </th>
  );
}
