import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sparkline } from "./Sparkline.js";

describe("Sparkline", () => {
  it("renders an empty svg when fewer than 2 points", () => {
    render(<Sparkline data={[1]} />);
    const svg = screen.getByTestId("sparkline");
    expect(svg.getAttribute("data-empty")).toBe("true");
    expect(svg.querySelector("polyline")).toBeNull();
  });

  it("renders a polyline with N points for non-empty data", () => {
    render(<Sparkline data={[1, 2, 3, 4]} width={100} height={20} />);
    const polyline = screen.getByTestId("sparkline").querySelector("polyline");
    expect(polyline).not.toBeNull();
    const points = polyline!.getAttribute("points")!.trim().split(/\s+/);
    expect(points).toHaveLength(4);
  });

  it("maps min/max into vertical extent", () => {
    render(<Sparkline data={[0, 10]} width={10} height={20} />);
    const points = screen
      .getByTestId("sparkline")
      .querySelector("polyline")!
      .getAttribute("points")!
      .trim()
      .split(/\s+/);
    // first point min → y=height, second point max → y=0
    expect(points[0]).toMatch(/,20\.00$/);
    expect(points[1]).toMatch(/,0\.00$/);
  });
});
