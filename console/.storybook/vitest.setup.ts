// Story tests check what is on screen. The kit's popovers and modals fade in, and a check that runs during the
// fade sees opacity 0, so tests run with animations and transitions finished at once.
const style = document.createElement("style");
style.textContent = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }";
document.head.append(style);
