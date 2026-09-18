/*
 * Service Worker del Cotizador Urbiola Llantas.
 *
 * Objetivo: que la app abra SIEMPRE (con o sin datos/señal), sin que el vendedor tenga
 * que hacer nada, Y que en cuanto haya una versión nueva (precios/HTML actualizado en
 * GitHub) se garantice que la vean de inmediato — cerrando su sesión a la fuerza para
 * que vuelvan a entrar ya con los datos frescos, en vez de dejarlos seguir usando la
 * versión vieja hasta que se les ocurra reabrir la app.
 *
 * Cómo funciona cada vez que se abre la app (con algo de señal):
 *  1) Se muestra al instante la copia guardada en el celular (nunca pantalla en blanco).
 *  2) Por detrás, se descarga la versión real desde GitHub y se compara, byte a byte, contra
 *     la copia guardada (contenido completo, no encabezados — ver bug corregido más abajo).
 *  3) Si SÍ cambió: se guarda la nueva copia y se le avisa a la página (mensaje
 *     "utl_nueva_version"). La página, al recibir ese aviso, cierra la sesión y recarga
 *     sola — el vendedor tiene que volver a poner su clave, y ya ve los datos nuevos.
 *  4) Si no cambió nada, no se avisa nada ni se interrumpe a nadie.
 *
 * Sin señal, sigue funcionando igual que antes: se queda con la última copia guardada.
 *
 * IMPORTANTE (bug corregido): GitHub Pages le dice al navegador que puede reusar el HTML
 * unos minutos sin volver a preguntar ("Cache-Control"). Si el service worker pedía el
 * archivo con fetch() normal, el propio navegador —no el service worker— a veces contestaba
 * con una copia vieja de SU caché interna, sin tocar la red de verdad. El resultado: la
 * comparación siempre salía "sin cambios" aunque sí hubiera una versión nueva en GitHub, y
 * la app instalada nunca se actualizaba (aunque visitar el link directo en el navegador sí
 * funcionara, porque ese caso no siempre pasa por esa misma caché). Por eso el fetch de la
 * página principal ahora se pide con {cache:'no-store'}, que obliga a ir siempre a la red.
 *
 * SEGUNDO bug corregido (25/08/2026, reportado por Baron: probó en iPhone instalado, en
 * navegador normal y en computadora, con espera, con regreso a la app y con refresh manual —
 * y en NINGUNO se actualizó). La comparación "rápida" por ETag/Last-Modified
 * (comparaPorEncabezados) podía decir "no cambió nada" de forma incorrecta: GitHub Pages sirve
 * a través de una red de servidores (Fastly) y, aunque {cache:'no-store'} obliga al NAVEGADOR a
 * no usar su propia caché, no obliga a esos servidores intermedios a tener ya la copia más
 * reciente — así que la comparación de encabezados podía comparar dos copias viejas entre sí y
 * concluir "sin cambios" aunque si hubiera una versión nueva esperando. Se quita por completo
 * esa ruta rápida: ahora SIEMPRE se compara el contenido completo del archivo (más lento, pero
 * 100% confiable — si el texto es distinto, se detecta sí o sí, sin depender de encabezados que
 * el servidor intermedio puede no tener actualizados todavía).
 *
 * TERCER bug corregido (17/09/2026, reportado por Ricardo: después de cada actualización de
 * precios, varios vendedores seguían viendo la fecha/lista vieja hasta que borraban a mano las
 * cookies y las imágenes en caché del navegador). Aunque {cache:'no-store'} evita que el
 * NAVEGADOR conteste con su copia guardada, la petición seguía pidiendo la MISMA dirección de
 * siempre — y esa red de servidores intermedios de GitHub (Fastly) puede seguir contestando con
 * su propia copia guardada para esa dirección exacta durante un rato después de publicar un
 * cambio, sin que nada en el navegador se entere. Ahora, solo para esta comparación interna, se
 * le agrega a la dirección que se pide por red un parámetro que cambia siempre (la hora exacta
 * en milisegundos) — así, para esos servidores intermedios, cada chequeo pide una dirección
 * distinta que nunca han visto antes, y no tienen manera de contestar con una copia vieja. La
 * dirección que ve el vendedor en la app nunca cambia; este parámetro es interno, solo para la
 * petición de comparación por detrás.
 */
const CACHE_VERSION = 'utl-v4';
const APP_PAGE = 'consulta-precios-llantas.html';
const APP_SHELL = [
  './',
  './consulta-precios-llantas.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(APP_SHELL).catch(function () {
        // Si algún ícono no carga la primera vez no debe tronar la instalación completa.
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_VERSION; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function avisarNuevaVersion() {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (clientList) {
    clientList.forEach(function (client) {
      client.postMessage({ type: 'utl_nueva_version' });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; // los POST a Google Sheets nunca pasan por aquí

  // Las llamadas a la API de Google Sheets (script.google.com) SIEMPRE van directo a la
  // red — nunca se deben cachear (son datos en vivo: folios, pendientes, disponibilidad).
  if (req.url.indexOf('script.google.com') !== -1) {
    return;
  }

  var esPaginaApp = req.url.indexOf(APP_PAGE) !== -1;

  // Para la página principal, forzamos que el fetch ignore la caché interna del navegador
  // (no-store) — así la comparación de versión siempre ve el archivo real que está en
  // GitHub en este momento, no una copia vieja que el navegador decidió reusar por su cuenta.
  var fetchOpts = esPaginaApp ? { cache: 'no-store' } : {};

  // Tarea 17/09/2026 (Ricardo): además de {cache:'no-store'} (que ya evita que el NAVEGADOR
  // conteste con su copia guardada), la dirección real que se pide por red lleva un parámetro
  // que cambia siempre (timestamp) SOLO para esta comparación — así ningún servidor intermedio
  // entre el navegador y GitHub (Fastly) puede contestar con una copia vieja que tenga guardada
  // para esa dirección exacta. Ver TERCER bug corregido arriba.
  var networkUrl = req.url;
  if (esPaginaApp) {
    networkUrl += (req.url.indexOf('?') === -1 ? '?' : '&') + '_utlcb=' + Date.now();
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      var networkFetch = fetch(networkUrl, fetchOpts).then(function (resp) {
        if (!resp || resp.status !== 200) return resp;

        if (esPaginaApp && cached) {
          var cachedForCompare = cached.clone();
          var respForCache = resp.clone();
          var respForCompare = resp.clone();
          // Comparación de contenido completo, siempre (ver bug corregido 25/08/2026 arriba) —
          // nada de encabezados de por medio, así que no importa si un servidor intermedio
          // todavía no tiene el ETag/Last-Modified más reciente.
          Promise.all([cachedForCompare.text(), respForCompare.text()]).then(function (vals) {
            caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, respForCache); });
            if (vals[0] !== vals[1]) avisarNuevaVersion();
          });
          return resp;
        }

        var copy = resp.clone();
        caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        return resp;
      }).catch(function () {
        // Sin internet: si no hay nada en cache tampoco, no hay nada más que devolver.
        return cached;
      });
      // Cache primero (instantáneo); si no hay nada guardado, se espera a la red.
      return cached || networkFetch;
    })
  );
});
