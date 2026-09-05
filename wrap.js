// Express 4 no entiende de promesas: si un handler `async` rechaza, el error
// no llega al middleware de errores y Node tumba el proceso entero. En Vercel
// eso es un 500 sin cuerpo y sin traza útil.
//
// Envuelve cada handler asíncrono con esto para que el rechazo pase por next()
// y termine en el manejador de errores de app.js.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
