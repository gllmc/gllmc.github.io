const themeToggleButton = document.getElementById("theme-toggle");
const themeToggleDarkIcon = document.getElementById("theme-toggle-dark-icon");
const themeToggleLightIcon = document.getElementById("theme-toggle-light-icon");

if (
    localStorage.getItem("color-theme") === "dark" ||
    (!("color-theme" in localStorage) &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
) {
    themeToggleLightIcon.classList.remove("hidden");
} else {
    themeToggleDarkIcon.classList.remove("hidden");
}

themeToggleButton.addEventListener("click", function () {
    const isCurrentlyDark = document.documentElement.classList.contains("dark");

    document.documentElement.classList.toggle("dark", !isCurrentlyDark);
    themeToggleLightIcon.classList.toggle("hidden", isCurrentlyDark);
    themeToggleDarkIcon.classList.toggle("hidden", !isCurrentlyDark);
    localStorage.setItem("color-theme", isCurrentlyDark ? "light" : "dark");
});
