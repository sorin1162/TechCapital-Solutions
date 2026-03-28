(function () {
  function resolveContactEndpoint(formEl) {
    var base = document.documentElement.getAttribute("data-api-base");
    if (base && typeof base === "string") {
      base = base.trim().replace(/\/$/, "");
      if (base) {
        return base + "/api/contact";
      }
    }
    var action = formEl.getAttribute("action");
    if (action && /^https?:\/\//i.test(action)) {
      return action;
    }
    return action || "/api/contact";
  }

  var toggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".nav-links");
  var form = document.getElementById("contact-form");
  var formStatus = document.getElementById("form-status");

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", nav.classList.contains("is-open"));
    });

    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  if (form && formStatus) {
    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      var submitButton = form.querySelector("button[type='submit']");
      var formData = new FormData(form);
      var payload = Object.fromEntries(formData.entries());

      formStatus.textContent = "Sending your message...";
      formStatus.className = "form-status";
      if (submitButton) {
        submitButton.disabled = true;
      }

      try {
        var endpoint = resolveContactEndpoint(form);
        var response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        var data = null;
        try {
          data = await response.json();
        } catch (_parseError) {
          data = null;
        }

        if (!response.ok) {
          var apiMessage =
            data && data.message
              ? data.message
              : "We could not send your message right now. Please try again shortly.";
          formStatus.textContent = apiMessage;
          formStatus.className = "form-status form-status--error";
          return;
        }

        var nextUrl = new URL("thank-you.html", window.location.href);
        if (data && data.id != null) {
          nextUrl.searchParams.set("id", String(data.id));
        }
        window.location.assign(nextUrl.href);
      } catch (_error) {
        var configured =
          document.documentElement.getAttribute("data-api-base") || "";
        var localhost =
          location.hostname === "localhost" ||
          location.hostname === "127.0.0.1" ||
          location.hostname === "";
        var staticSiteNeedsApi = !String(configured).trim() && !localhost;
        formStatus.textContent = staticSiteNeedsApi
          ? "This site is static (e.g. GitHub Pages) — the contact API must run elsewhere. Set data-api-base on <html> to your API base URL, and ALLOWED_ORIGINS on the server to " +
            location.origin +
            "."
          : "We could not send your message. Check the API URL, CORS (ALLOWED_ORIGINS), and SMTP, then try again.";
        formStatus.className = "form-status form-status--error";
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
        }
      }
    });
  }
})();
