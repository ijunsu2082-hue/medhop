import { MARKER_7, SIGN } from "../../scene/room";

// The printed station sign, drawn to scale in millimetres: an A4 sheet, the 180 mm marker 30 mm from the top.
const SHEET_W = SIGN.sheetWidth * 1000;
const SHEET_H = SIGN.sheetHeight * 1000;
const MARKER = SIGN.markerSize * 1000;
const LEFT = (SHEET_W - MARKER) / 2;
const TOP = SIGN.topMargin * 1000;
const CELL = MARKER / MARKER_7.length;

export function SignFigure() {
  return (
    <svg
      className="sign-svg"
      viewBox={`0 0 ${SHEET_W} ${SHEET_H}`}
      role="img"
      aria-label="The station sign: a black and white square marker on a sheet of A4, captioned Medicine Station A"
    >
      <rect className="sign-sheet" x={0.5} y={0.5} width={SHEET_W - 1} height={SHEET_H - 1} />
      <rect className="sign-ink" x={LEFT} y={TOP} width={MARKER} height={MARKER} />
      {MARKER_7.flatMap((row, r) =>
        [...row].map((bit, c) =>
          bit === "1" ? (
            <rect
              key={`${r}-${c}`}
              className="sign-paper"
              x={LEFT + c * CELL}
              y={TOP + r * CELL}
              width={CELL + 0.2}
              height={CELL + 0.2}
            />
          ) : null,
        ),
      )}
      <text className="sign-caption" x={SHEET_W / 2} y={TOP + MARKER + 30} textAnchor="middle">
        {SIGN.caption}
      </text>
    </svg>
  );
}
