export function submitOnEnter(
  inputEl: HTMLInputElement,
  submit: () => void | Promise<void>,
): void {
  inputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) {
      return;
    }

    event.preventDefault();
    void submit();
  });
}
