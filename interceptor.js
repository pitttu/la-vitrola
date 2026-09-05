/* API falsa para un CMS que ya no existe.
 *
 * La ficha de cada caratula no sale del payload: el componente pide sus
 * datos a graphql.datocms.com con la consulta Article. Ese proyecto se
 * apago, asi que la peticion falla y el panel lateral se abre vacio. Era
 * asi tambien en el espejo original; nunca se llego a capturar, porque el
 * contenido no estaba en el HTML sino detras de una llamada.
 *
 * Aqui se intercepta fetch y se responde desde api-fichas.json, que genera
 * construir.py a partir de los .toml. La app no se entera: recibe la misma
 * forma que le daba DatoCMS, la renderiza con su propio marcado y sus
 * animaciones se disparan solas.
 *
 * Tiene que ir ANTES del bundle, y cubre los dos caminos: al cargar la
 * pagina directamente y al navegar con un clic desde surf.
 */
(function () {
  'use strict';

  var BASE = window.__TLB_BASE__ || '';
  var cache = null;

  function datos() {
    if (!cache) {
      cache = fetch(BASE + '/api-fichas.json').then(function (r) { return r.json(); });
    }
    return cache;
  }

  function responder(cuerpo) {
    return new Response(JSON.stringify(cuerpo), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  var original = window.fetch.bind(window);

  // fetch admite texto, un objeto URL o un Request, y cada uno guarda la
  // direccion en un sitio distinto. graphql-request usa URL, que no tiene
  // .url: mirar solo ahi devolvia cadena vacia, no se reconocia el dominio
  // y la llamada se escapaba a la red de verdad.
  function direccion(recurso) {
    if (typeof recurso === 'string') return recurso;
    if (!recurso) return '';
    return recurso.url || recurso.href || String(recurso);
  }

  window.fetch = function (recurso, opciones) {
    var url = direccion(recurso);
    if (url.indexOf('graphql.datocms.com') === -1) {
      return original.apply(null, arguments);
    }

    var cuerpo = {};
    try {
      var crudo = (opciones && opciones.body) ||
                  (recurso && recurso.body) || '{}';
      cuerpo = typeof crudo === 'string' ? JSON.parse(crudo) : {};
    } catch (e) { /* si no se puede leer, se responde vacio */ }

    var slug = cuerpo.variables && cuerpo.variables.slug;

    return datos().then(function (d) {
      // Con slug es la consulta Article; sin slug, Settings.
      if (slug) return responder({ data: { page: d.fichas[slug] || null } });
      return responder({ data: d.settings });
    }).catch(function () {
      return responder({ data: {} });
    });
  };
})();
