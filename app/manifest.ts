import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
    return { name: 'Pancake Auction', short_name: 'Pancake', description: 'Pancake sealed-bid auction',
        start_url: '/', display: 'standalone', background_color: '#e8ecf1', theme_color: '#e8ecf1',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] };
}
