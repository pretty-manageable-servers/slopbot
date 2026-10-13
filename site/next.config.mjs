/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static files in out/ for Cloudflare Pages.
  output: 'export',
  images: { unoptimized: true },
}

export default nextConfig
