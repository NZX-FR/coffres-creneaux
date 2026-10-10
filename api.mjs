import { getStore } from '@netlify/blobs';
import { handle } from '../lib/core.mjs';

export default async (req) => handle(req, getStore({ name: 'coffres-creneaux', consistency: 'strong' }));

export const config = { path: '/api/*' };
