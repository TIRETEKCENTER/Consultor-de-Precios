/*
 * Service Worker del Cotizador Urbiola Llantas — versión 2 (03/11/2026, Ricardo).
 *
 * Qué hace: que la app abra SIEMPRE (con o sin señal) mostrando la última copia guardada.
 *
 * Qué YA NO hace: decidir si hay versión nueva. Eso ahora lo revisa la propia pantalla
 * (ver "Actualización de la app (versión 2)" en consulta-precios-llantas.html). Antes, si el
 * único aviso que mandaba este archivo se perdía, la app se quedaba con la versión vieja hasta
 * que el vendedor borraba los datos de navegación. Historia de los bugs anteriores (caché del
 * navegador, ETag/Fastly, parámetro con la hora): ver versión utl-v4 en el historial de GitHub.
 *
 * Reglas:
 *  - Peticiones con "__ver=" (la revisión de versión de la pantalla) y las de Google Sheets
 *    (script.google.com) van directo a la red, nunca se guardan.
 *  - La página principal se guarda con UNA sola llave (la dirección sin "?..."), así un link
 *    con algo extra al final (WhatsApp, ?v=fecha) abre y actualiza la misma copia.
 *  - Al activarse solo borra SUS cachés viejas (prefijo utl-). Las apps de producción y de
 *    pruebas viven en el mismo dominio (tiretekcenter.github.io) y comparten el almacenamiento:
 *    la versión anterior borraba TODAS las cachés ajenas, incluida la de la otra app.
 */
const CACHE_PREFIX = 'utl-';
const CACHE_VERSION = 'utl-v5';
const APP_PAGE = 'consulta-precios-llantas.html';
const APP_SHELL = [
  './consulta-precios-llantas.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

function urlCanonica(url) {
  var u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}
function esPaginaApp(url) {
  var u = new URL(url);
  return u.pathname.slice(-APP_PAGE.length) === APP_PAGE;
}
function esRaizApp(url) {
  var u = new URL(url);
  var scopePath = new URL(self.registration.scope).pathname;
  return u.pathname === scopePath || u.pathname === scopePath + 'index.html';
}

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return Promise.all(APP_SHELL.map(function (p) {
        return fetch(new Request(p, { cache: 'reload' })).then(function (resp) {
          if (resp && resp.ok) return cache.put(urlCanonica(new URL(p, self.registration.scope).href), resp);
        }).catch(function () { /* un ícono que no cargue no debe tronar la instalación */ });
      }));
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_VERSION; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
      .then(function () {
        // Al entrar un sw.js nuevo, avisar a las pantallas abiertas. Las de la versión anterior
        // (que solo saben recargar con este aviso) se recargan ya con la nueva; las de la versión 2
        // solo hacen su revisión normal. Va dentro de waitUntil para que el navegador no corte el
        // aviso a la mitad (el sw.js anterior perdía su aviso justo en este momento).
        return self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      })
      .then(function (clientList) {
        clientList.forEach(function (client) {
          if (new URL(client.url).pathname.indexOf(new URL(self.registration.scope).pathname) === 0) {
            client.postMessage({ type: 'utl_nueva_version' });
          }
        });
      })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;                              // POST a Sheets: directo
  if (req.url.indexOf('script.google.com') !== -1) return;       // datos en vivo: directo
  if (req.url.indexOf('__ver=') !== -1) return;                  // revisión de versión: directo
  if (new URL(req.url).origin !== self.location.origin) return;  // CDN, fuentes: navegador normal

  // Raíz (index.html): red primero; sin internet, abrir la app guardada.
  if (esRaizApp(req.url)) {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match(urlCanonica(new URL(APP_PAGE, self.registration.scope).href));
      })
    );
    return;
  }

  var llave = urlCanonica(req.url);
  if (esPaginaApp(req.url)) {
    // Página: abrir al instante la copia guardada. Si no hay copia, red y se guarda.
    event.respondWith(
      caches.open(CACHE_VERSION).then(function (cache) {
        return cache.match(llave).then(function (cached) {
          if (cached) return cached;
          return fetch(llave, { cache: 'no-store' }).then(function (resp) {
            if (resp && resp.ok) cache.put(llave, resp.clone());
            return resp;
          });
        });
      })
    );
    return;
  }

  // Resto de archivos propios (manifest, íconos): copia guardada o red.
  event.respondWith(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.match(llave).then(function (cached) {
        var red = fetch(req).then(function (resp) {
          if (resp && resp.ok) cache.put(llave, resp.clone());
          return resp;
        }).catch(function () { return cached; });
        return cached || red;
      });
    })
  );
});
