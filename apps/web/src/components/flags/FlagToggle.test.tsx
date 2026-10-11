import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FlagToggle } from "./FlagToggle";

/** The toggle is controlled (it shows what it is told), so tests wrap it in a parent that holds the value. */
function Harness({ initial = false, onChange = () => {}, disabled = false }: { initial?: boolean; onChange?: (next: boolean) => void; disabled?: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <FlagToggle
      checked={on}
      disabled={disabled}
      label="Instant payouts in Staging"
      showStatus
      onCheckedChange={(next) => {
        onChange(next);
        setOn(next);
      }}
    />
  );
}

const toggle = () => screen.getByRole("switch", { name: "Instant payouts in Staging" });
const bloom = () => document.querySelector("[data-bloom]");

describe("FlagToggle", () => {
  it("is a real switch with a name, reporting its state to assistive tech", () => {
    render(<Harness />);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(toggle().tagName).toBe("BUTTON");
  });

  it("asks to change when clicked, with the value it wants", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(toggle());
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(toggle()).toBeChecked();
    await userEvent.click(toggle());
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("is reachable with Tab and flips with Space or Enter", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(toggle()).toHaveFocus();
    await user.keyboard(" ");
    expect(toggle()).toBeChecked();
    await user.keyboard("{Enter}");
    expect(toggle()).not.toBeChecked();
  });

  it("shows what it is told: a parent that refuses the change keeps it where it was", async () => {
    // This is what makes the Production guard possible: the click only REQUESTS a change.
    const onChange = vi.fn();
    render(<FlagToggle checked label="Instant payouts in Staging" onCheckedChange={onChange} />);
    await userEvent.click(toggle());
    expect(onChange).toHaveBeenCalledWith(false);
    expect(toggle()).toBeChecked();
  });

  it("does nothing when disabled (a read-only role)", async () => {
    const onChange = vi.fn();
    render(<Harness disabled onChange={onChange} />);
    expect(toggle()).toBeDisabled();
    await userEvent.click(toggle());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("writes the state as text, hidden from screen readers (the switch already says it)", async () => {
    render(<Harness />);
    const status = screen.getByText("off");
    expect(status.closest("[aria-hidden]")).not.toBeNull();
    await userEvent.click(toggle());
    expect(await screen.findByText("on")).toBeInTheDocument();
  });

  it("plays the ember bloom when it turns ON, and only then", async () => {
    render(<Harness />);
    expect(bloom()).toBeNull();
    await userEvent.click(toggle()); // off -> on
    expect(bloom()).not.toBeNull();
  });

  it("does not bloom on first render of a flag that is already on, nor when turning off", async () => {
    render(<Harness initial />);
    expect(bloom()).toBeNull();
    await userEvent.click(toggle()); // on -> off
    expect(bloom()).toBeNull();
  });

  it("blooms when the value is changed from outside too (a live update turning it on)", () => {
    const { rerender } = render(<FlagToggle checked={false} label="x" onCheckedChange={() => {}} />);
    rerender(<FlagToggle checked label="x" onCheckedChange={() => {}} />);
    expect(bloom()).not.toBeNull();
  });
});
