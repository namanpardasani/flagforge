import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HOLD_MS, HoldToConfirm } from "./hold-to-confirm";

const HOLD = 150; // a short hold keeps these tests quick; the real default is checked separately
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const button = () => screen.getByRole("button", { name: /Hold to turn off|Keep holding|Done/ });

function setup(props: Partial<Parameters<typeof HoldToConfirm>[0]> = {}) {
  const onConfirm = vi.fn();
  render(
    <HoldToConfirm holdMs={HOLD} onConfirm={onConfirm} {...props}>
      Hold to turn off
    </HoldToConfirm>,
  );
  return { onConfirm, user: userEvent.setup() };
}

describe("HoldToConfirm", () => {
  it("takes 700ms by default", () => {
    expect(HOLD_MS).toBe(700);
  });

  it("does nothing on a plain click", async () => {
    const { onConfirm, user } = setup();
    await user.click(button());
    await sleep(HOLD * 2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms once after the pointer is held for the full time", async () => {
    const { onConfirm, user } = setup();
    const started = Date.now();
    await user.pointer({ keys: "[MouseLeft>]", target: button() });
    expect(onConfirm).not.toHaveBeenCalled(); // not at the moment of pressing
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD - 20);
    await user.pointer({ keys: "[/MouseLeft]" });
    await sleep(HOLD * 2);
    expect(onConfirm).toHaveBeenCalledTimes(1); // releasing afterwards does not fire it again
  });

  it("cancels when released early, and a later full hold still works", async () => {
    const { onConfirm, user } = setup();
    await user.pointer({ keys: "[MouseLeft>]", target: button() });
    await sleep(HOLD / 3);
    await user.pointer({ keys: "[/MouseLeft]" });
    await sleep(HOLD * 2);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.pointer({ keys: "[MouseLeft>]", target: button() });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("two short presses do not add up to one long one", async () => {
    // A long hold time and short presses, so a slow machine cannot turn a press into a full hold.
    const { onConfirm, user } = setup({ holdMs: 1500 });
    for (let i = 0; i < 3; i++) {
      await user.pointer({ keys: "[MouseLeft>]", target: button() });
      await sleep(120);
      await user.pointer({ keys: "[/MouseLeft]" });
      await sleep(120);
    }
    await sleep(300);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says what is happening while held", async () => {
    const { user } = setup();
    await user.pointer({ keys: "[MouseLeft>]", target: button() });
    expect(button()).toHaveTextContent("Keep holding");
    expect(button()).toHaveAttribute("data-holding", "true");
    await user.pointer({ keys: "[/MouseLeft]" });
    expect(button()).toHaveTextContent("Hold to turn off");
  });

  it("works from the keyboard: holding Space or Enter confirms, a tap does not", async () => {
    const { onConfirm, user } = setup();
    button().focus();
    await user.keyboard("{Enter}"); // press and release at once
    await sleep(HOLD * 2);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.keyboard("{Enter>}");
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await user.keyboard("{/Enter}");
  });

  it("is not restarted by the key repeating while held (the hold would otherwise never finish)", async () => {
    const { onConfirm } = setup();
    button().focus();
    fireEvent.keyDown(button(), { key: " " });
    for (let i = 0; i < 6; i++) {
      await sleep(HOLD / 5);
      fireEvent.keyDown(button(), { key: " ", repeat: true });
    }
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("cancels if focus leaves or the pointer is taken away mid-hold", async () => {
    const { onConfirm, user } = setup();
    await user.pointer({ keys: "[MouseLeft>]", target: button() });
    fireEvent.blur(button());
    await sleep(HOLD * 2);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.pointer({ keys: "[/MouseLeft]" });

    fireEvent.pointerDown(button(), { button: 0 });
    fireEvent.pointerCancel(button());
    await sleep(HOLD * 2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores the right mouse button", async () => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button(), { button: 2 });
    await sleep(HOLD * 2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cannot be held while disabled", async () => {
    const { onConfirm, user } = setup({ disabled: true });
    expect(button()).toBeDisabled();
    await user.pointer({ keys: "[MouseLeft>]", target: button() });
    await sleep(HOLD * 2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("explains itself to screen readers without the explanation becoming its name", () => {
    setup({ holdMs: 700 });
    expect(button()).toHaveAccessibleName("Hold to turn off");
    expect(button()).toHaveAccessibleDescription("Press and hold for 0.7 seconds to confirm. Releasing early cancels.");
  });
});
