# Render generated images in web chat

Bot replies and other members' messages now show image attachments inline. Markdown images and links to image files also show previews, including signed graph URLs. Previews link to the original image and attachment load failures keep a readable fallback link.

Image loads use HTTPS without sending the page referrer. Executable URLs, data URLs and URLs containing credentials cannot become previews. The console image policy permits HTTPS images while keeping scripts and connections restricted to the app.
