/** Opt-in flag for the next immersive-office interaction layer. The existing Web/3D experience stays the default. */
export const immersiveOfficeEnabled = (): boolean => import.meta.env?.VITE_BFLOW_IMMERSIVE_OFFICE === 'true';
