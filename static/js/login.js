"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const { auth } = window.ADS;
  const form = document.getElementById("login-form");
  const input = document.getElementById("token");
  const remember = document.getElementById("remember");
  const submit = document.getElementById("login-submit");
  const msg = document.getElementById("login-msg");

  function show(text, kind) {
    msg.textContent = text;
    msg.className = `alert alert-${kind}`;
    msg.hidden = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = input.value.trim();
    if (!token) {
      show("Please enter your token.", "error");
      input.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = "Checking…";
    try {
      // Verify the token before storing it.
      const res = await fetch("/api/tags", { headers: { "X-Auth-Token": token } });
      if (res.status === 403 || res.status === 401) {
        show("That token isn't valid.", "error");
        input.select();
        return;
      }
      if (!res.ok) {
        show(`Server error (${res.status}). Please try again.`, "error");
        return;
      }
      auth.set(token, remember.checked);
      show("Signed in. Redirecting…", "success");
      window.location.replace("/");
    } catch (_) {
      show("Couldn't reach the server.", "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });
});
