(function () {
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
        var response = await fetch(form.action, {
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
        formStatus.textContent =
          "We could not send your message right now. Please try again shortly.";
        formStatus.className = "form-status form-status--error";
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
        }
      }
    });
  }
})();
