/* Reproductor de la ficha.
 *
 * Va debajo del titulo, en el panel derecho del articulo: una barra con un
 * separador en cada corte, los mandos, y —si es un album— el indice de
 * temas con su minuto.
 *
 * No toca el bundle. Es un componente aparte que se cuelga del DOM cuando
 * detecta que hay una ficha montada, y se descuelga al salir. El sitio es
 * una SPA, asi que esto vive en todas las paginas y se entera de los
 * cambios de ruta observando el DOM, no por eventos de pagina.
 *
 * Para saltar de caratula NO navega por su cuenta: dispara la misma tecla
 * que el sitio ya escucha (ArrowLeft/ArrowRight). Asi la navegacion y su
 * animacion las hace el propio sitio, y esto funciona igual en escritorio
 * —donde los vecinos son las portadas de los lados— que en movil, donde
 * son los botones de abajo.
 *
 * ── sobre la rocola ──
 *
 * Arriba a la derecha vive el reproductor del sitio con su propio <audio>.
 * No son dos aparatos distintos: si lo que esta sonando ahi pertenece a
 * esta caratula, esto ADOPTA ese <audio> en vez de abrir otro. La barra
 * enseña donde va de verdad, y el play, la pausa y la aguja actuan sobre
 * el mismo elemento, asi que la rocola se entera y su propia interfaz
 * sigue en su sitio.
 *
 * Se toma el mando propio solo cuando la rocola no puede seguir: al
 * cambiar de tema dentro de un album, porque su lista enseña cinco pistas
 * al azar y puede no tener la que toca. Entonces se le para, se copia la
 * posicion y se continua en el <audio> de aqui.
 */
(function () {
  'use strict';

  var BASE = window.__TLB_BASE__ || '';

  var datos = null;      // reproductor.json
  var slug = null;       // ficha montada ahora mismo
  var disco = null;      // sus datos
  var idx = 0;           // corte sonando
  var seguir = false;    // venimos de un salto automatico: hay que seguir
  var propio = null;     // el <audio> de esta ficha
  var ajeno = null;      // el de la rocola, mientras este adoptado
  var precarga = null;   // <audio> oculto que adelanta el siguiente corte
  var ui = null;         // nodos de la interfaz

  /* Que hay cargado AHORA MISMO en `propio`.
   *
   * No vale mirar el elemento para saberlo. Quitarle el atributo src no
   * limpia currentSrc: el recurso anterior sigue ahi hasta que se llama a
   * load(). Fiandose de currentSrc, al abrir otra ficha y dar al play
   * sonaba lo de la ficha anterior, que seguia cargado. */
  var cargada = '';

  /* Donde quedo cada disco: {slug: {idx, t}}. Al volver a una caratula se
   * retoma el tema y el minuto en que la dejaste. */
  var memoria = {};
  var pendiente = 0;     // minuto por retomar, aun sin cargar

  function act() { return ajeno || propio; }

  // ── utilidades ──────────────────────────────────────────────────

  function reloj(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function slugDeRuta() {
    var m = location.pathname.match(/\/articles\/([^\/?#]+)/);
    return m ? m[1] : null;
  }

  function svg(d) {
    return '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="' + d + '"/></svg>';
  }
  var ICONO = {
    tocar:  'M10.5 6L2 11.2V.8L10.5 6Z',
    pausa:  'M2 1h2.6v10H2V1Zm5.4 0H10v10H7.4V1Z',
    atras:  'M2 1h1.8v10H2V1Zm9 0v10L4.2 6 11 1Z',
    delante:'M10 1h1.8v10H10V1ZM1 1l6.8 5L1 11V1Z'
  };

  function escapar(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── el plato ────────────────────────────────────────────────────
  //
  // Al arrancar y al parar suena a vinilo. No es una grabacion imitando el
  // efecto: es el efecto.
  //
  // Lo que hace reconocible a un plato frenando es que el tono cae con la
  // velocidad. Eso se consigue rampando playbackRate del propio audio con
  // preservesPitch apagado —por defecto los navegadores corrigen el tono,
  // que es justo lo que hay que evitar aqui—. Encima va el siseo de la
  // aguja, sintetizado al vuelo: ni un archivo que descargar.

  var VINILO = true;
  var actx;                 // undefined = sin abrir; null = no disponible
  var ruidoBuf = null;
  var giro = 0;             // token, para que dos rampas no se peleen

  function ctx() {
    if (actx === undefined) {
      var C = window.AudioContext || window.webkitAudioContext;
      try { actx = C ? new C() : null; } catch (e) { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }

  function ruido(c) {
    if (!ruidoBuf) {
      var n = Math.floor(c.sampleRate * 0.6);
      ruidoBuf = c.createBuffer(1, n, c.sampleRate);
      var d = ruidoBuf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return ruidoBuf;
  }

  /* El siseo de la aguja. Subiendo al posarla, cayendo al levantarla. */
  function aguja(subiendo) {
    var c = VINILO && ctx();
    if (!c) return;
    var t = c.currentTime, dur = 0.4;

    var src = c.createBufferSource(); src.buffer = ruido(c);
    var filtro = c.createBiquadFilter();
    filtro.type = 'bandpass'; filtro.Q.value = 0.7;
    var vol = c.createGain();
    src.connect(filtro); filtro.connect(vol); vol.connect(c.destination);

    if (subiendo) {
      filtro.frequency.setValueAtTime(320, t);
      filtro.frequency.exponentialRampToValueAtTime(2400, t + dur);
      vol.gain.setValueAtTime(0.0001, t);
      vol.gain.exponentialRampToValueAtTime(0.05, t + 0.06);
      vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      // el chasquido de posarla en el surco
      var cl = c.createOscillator(), cg = c.createGain();
      cl.type = 'triangle';
      cl.frequency.setValueAtTime(95, t);
      cg.gain.setValueAtTime(0.07, t);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      cl.connect(cg); cg.connect(c.destination);
      cl.start(t); cl.stop(t + 0.09);
    } else {
      filtro.frequency.setValueAtTime(2200, t);
      filtro.frequency.exponentialRampToValueAtTime(170, t + dur);
      vol.gain.setValueAtTime(0.055, t);
      vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    src.start(t); src.stop(t + dur + 0.05);
  }

  /* Lleva el plato de una velocidad a otra. Con el tono suelto, para que
   * caiga y suba con ella. */
  function girar(el, desde, hasta, ms, alAcabar) {
    if (!el) { if (alAcabar) alAcabar(); return; }
    var mio = ++giro;
    if (!VINILO) {
      el.playbackRate = hasta;
      if (alAcabar) alAcabar();
      return;
    }
    try {
      el.preservesPitch = false;
      el.mozPreservesPitch = false;
      el.webkitPreservesPitch = false;
    } catch (e) { /* si no deja, se oira sin caida de tono */ }
    var t0 = performance.now();
    (function paso() {
      if (mio !== giro) return;           // otra rampa tomo el relevo
      var k = Math.min(1, (performance.now() - t0) / ms);
      try { el.playbackRate = desde + (hasta - desde) * k; } catch (e) {}
      if (k < 1) requestAnimationFrame(paso);
      else if (alAcabar) alAcabar();
    })();
  }

  function arrancar_plato(el) {
    aguja(true);
    el.playbackRate = 0.35;
    var p = el.play();
    if (p && p.catch) p.catch(function () {});
    girar(el, 0.35, 1, 320);
  }

  function frenar_plato(el) {
    aguja(false);
    girar(el, el.playbackRate || 1, 0.12, 330, function () {
      el.pause();
      el.playbackRate = 1;
    });
  }

  // ── el audio y su dueño ─────────────────────────────────────────

  var oyentes = {
    timeupdate: function () { recordar(); pintar(); adelantarSiguiente(); },
    play: pintar,
    pause: pintar,
    loadedmetadata: pintar,
    ended: function () {
      // Si manda la rocola, que avance ella y ya nos enteraremos al
      // resincronizar. Meter mano aqui seria pelearse con su propio
      // manejador por la misma pista.
      if (ajeno) { setTimeout(sincronizar, 0); return; }
      alTerminar();
    }
  };

  function escuchar(el) {
    if (!el) return;
    for (var k in oyentes) el.addEventListener(k, oyentes[k]);
  }
  function sordo(el) {
    if (!el) return;
    for (var k in oyentes) el.removeEventListener(k, oyentes[k]);
  }

  function crearPropio() {
    if (propio) return;
    propio = document.createElement('audio');
    propio.preload = 'auto';
    propio.setAttribute('data-tlb', 'reproductor');
    document.body.appendChild(propio);
    escuchar(propio);

    precarga = document.createElement('audio');
    precarga.preload = 'auto';
    precarga.muted = true;
    precarga.setAttribute('data-tlb', 'precarga');
    document.body.appendChild(precarga);
  }

  /* El <audio> de la rocola: el unico que no lleva marca nuestra. */
  function rocola() {
    return document.querySelector('audio:not([data-tlb])');
  }

  /* A que corte de ESTA ficha corresponde lo que suena en ese elemento.
   * -1 si no es de aqui. */
  function cualCorte(el) {
    if (!disco || !el) return -1;
    var src = el.currentSrc || el.getAttribute('src') || '';
    if (!src) return -1;
    for (var i = 0; i < disco.cortes.length; i++) {
      if (src.indexOf(disco.cortes[i].url) !== -1) return i;
    }
    return -1;
  }

  /* Mira que suena en la rocola y decide si esta ficha lo adopta.
   *
   * "Que suena", no "que tiene cargado". Un <audio> conserva su src
   * despues de parar, asi que la rocola se queda apuntando a lo ultimo que
   * toco durante el resto de la sesion. Adoptandola por el src a secas,
   * entrar en la ficha de ESE disco daba por adoptado un elemento parado y
   * callaba lo que estuviera sonando aqui: mandaba el que no sonaba sobre
   * el que si.
   *
   * Se notaba sobre todo con el disco de dieciocho cortes, porque ocupa mas
   * de un cuarto de las pistas de la rocola y casi siempre era suyo lo
   * ultimo que ella habia tocado.
   *
   * Si la rocola esta parada pero aqui tampoco suena nada, se adopta igual:
   * no hay nada que pisar y asi la barra abre en el minuto donde se quedo
   * en vez de en cero, que es para lo que se hizo esto. */
  function sincronizar() {
    if (!disco) { soltar(false); return; }
    var el = rocola();
    var n = cualCorte(el);
    var manda = n >= 0 && (!el.paused || !propio || propio.paused);
    if (manda) {
      if (ajeno !== el) {
        soltar(false);
        ajeno = el;
        escuchar(ajeno);
      }
      idx = n;
      if (propio && !propio.paused) propio.pause();
    } else if (ajeno) {
      soltar(false);
    }
    pintar();
  }

  function soltar(parar) {
    if (!ajeno) return;
    if (parar) ajeno.pause();
    sordo(ajeno);
    ajeno = null;
  }

  /* Si lo que `propio` tiene dentro es el corte que esta ficha muestra
   * ahora. Al salir de una caratula la musica sigue, asi que el elemento
   * puede estar tocando lo de OTRA: sin esta comprobacion, la barra de
   * aqui pintaba el minuto de aquella. */
  function propioEsDeAqui() {
    return !!(disco && cargada &&
              cargada === BASE + disco.cortes[idx].url);
  }

  /* Cuanto lleva el corte actual, este quien este al mando. Si no hay nada
   * cargado, lo que quedo apuntado de la ultima visita. */
  function dentroDelCorte() {
    if (ajeno) return ajeno.currentTime || 0;
    if (propioEsDeAqui()) return propio.currentTime || 0;
    return pendiente;
  }

  function recordar() {
    if (slug && disco) memoria[slug] = { idx: idx, t: dentroDelCorte() };
  }

  /* Suena LO DE ESTA FICHA. Que suene otra cosa no cuenta: de eso depende
   * que salga el disco y que el boton pare o arranque. */
  function sonando() {
    if (ajeno) return !ajeno.paused;
    return !!(propioEsDeAqui() && propio && !propio.paused);
  }

  function adelantarSiguiente() {
    var a = act();
    if (!disco || !a || !a.duration) return;
    var queda = a.duration - a.currentTime;
    var sig = disco.cortes[idx + 1];
    if (!sig || queda > 4 || queda < 0 || !precarga) return;
    var url = BASE + sig.url;
    if (precarga.getAttribute('src') !== url) {
      precarga.setAttribute('src', url);
      precarga.load();
    }
  }

  // ── control ─────────────────────────────────────────────────────

  function poner(n, tocar, desde, conAguja) {
    if (!disco || !disco.cortes[n]) return;
    // Si mandaba la rocola, se le retira el mando: aqui vamos a cargar
    // otra cosa y no puede seguir sonando lo suyo por debajo.
    if (ajeno) soltar(true);
    crearPropio();
    idx = n;
    pendiente = 0;
    var url = BASE + disco.cortes[n].url;
    if (cargada !== url) {
      propio.setAttribute('src', url);
      propio.load();
      cargada = url;
    }
    giro++;                       // corta cualquier rampa a medias
    propio.playbackRate = 1;
    if (desde) {
      var ir = function () {
        propio.currentTime = desde;
        propio.removeEventListener('loadedmetadata', ir);
      };
      propio.addEventListener('loadedmetadata', ir);
    }
    if (tocar) {
      // Con aguja solo cuando se arranca a proposito. Encadenando temas
      // de un album no suena: un disco de verdad tampoco chasquea entre
      // corte y corte.
      if (conAguja) {
        arrancar_plato(propio);
      } else {
        var p = propio.play();
        if (p && p.catch) p.catch(function () { /* sin permiso: ni modo */ });
      }
    }
    pintar();
  }

  function alternar() {
    var a = act();
    if (!disco || !a) return;
    if (sonando()) { frenar_plato(a); seguir = false; return; }
    // Si lo que suena es de otra caratula, aqui no se para: se releva.
    // Y si el elemento tiene cargado otro corte, se carga el de esta
    // ficha antes de sonar; reanudar a ciegas era lo que hacia sonar el
    // album anterior al abrir un single.
    if (!ajeno && !propioEsDeAqui()) {
      poner(idx, true, pendiente, true);
      return;
    }
    arrancar_plato(a);
  }

  function alTerminar() {
    if (!disco) return;
    if (idx + 1 < disco.cortes.length) {
      poner(idx + 1, true);
    } else {
      // Se acabo el disco: que lo siga el vecino, como si hubieras
      // pinchado su portada.
      seguir = true;
      saltarFicha(1);
    }
  }

  function siguiente() {
    if (disco && disco.album && idx + 1 < disco.cortes.length) {
      poner(idx + 1, sonando() || seguir, 0, !sonando());
    } else {
      seguir = sonando();
      saltarFicha(1);
    }
  }

  function anterior() {
    var a = act();
    // Como en cualquier reproductor: si ya avanzo un poco, "atras" es
    // volver al principio del tema antes que cambiar de tema.
    if (disco && disco.album && a && a.currentTime > 2) {
      a.currentTime = 0;
      return;
    }
    if (disco && disco.album && idx > 0) {
      poner(idx - 1, sonando() || seguir, 0, !sonando());
    } else {
      seguir = sonando();
      saltarFicha(-1);
    }
  }

  /* No navegamos: disparamos la tecla que el sitio ya escucha en window,
   * y deja que sea el quien navegue con su transicion. Si no hay vecino,
   * su manejador no hace nada y aqui tampoco pasa nada. */
  function saltarFicha(dir) {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: dir > 0 ? 'ArrowRight' : 'ArrowLeft',
      bubbles: true, cancelable: true
    }));
  }

  function posicion() {
    if (!disco) return 0;
    return disco.cortes[idx].inicio + dentroDelCorte();
  }

  function irA(seg) {
    if (!disco) return;
    seg = Math.max(0, Math.min(disco.total - .05, seg));
    var n = 0;
    for (var i = 0; i < disco.cortes.length; i++) {
      if (seg >= disco.cortes[i].inicio) n = i;
    }
    var dentro = seg - disco.cortes[n].inicio;
    // Dentro del mismo corte basta mover la aguja, y si manda la rocola
    // se mueve la suya: no hace falta quitarle el mando para eso.
    if (n === idx && (ajeno || cargada)) {
      act().currentTime = dentro;
    } else if (n === idx) {
      pendiente = dentro;          // aun sin cargar: se apunta el minuto
    } else {
      poner(n, sonando(), dentro);
    }
    recordar();
    pintar();
  }

  // ── el disco que asoma tras la caratula ─────────────────────────
  //
  // Solo en la ficha, solo mientras suena, y solo en la que esta sonando:
  // vive dentro de la columna de la portada, asi que ni existe en surf ni
  // en la portada del sitio.

  var vinilo = null, guardando = null;

  /* Cuando el sitio cambia de pagina no hace un fundido: coge las
   * portadas y las lleva de un sitio a otro, reinsertandolas en otro
   * contenedor. Perseguir esa coreografia desde fuera es imposible —
   * siempre se va un fotograma por detras, y en ese hueco el disco
   * asoma donde no debe.
   *
   * Asi que no se persigue: se MIDE. Cada fotograma se compara el
   * rectangulo de la portada con un ancla; si se aparto, es que algo la
   * esta moviendo y el disco se esconde al instante. Vuelve a salir solo
   * cuando lleva QUIETO fotogramas clavada.
   *
   * La gracia es que no hay que saber que animacion es. Vale igual para
   * entrar desde la timeline, pasar de una caratula a otra o volver a
   * surf, y seguira valiendo para las que se anadan.
   *
   * Dos detalles que parecen manias y no lo son:
   *
   * Se compara contra un ANCLA fija —el sitio donde la portada se quedo
   * la ultima vez que se movio— y no contra el fotograma anterior. El
   * sitio anima las portadas con una curva que frena mucho al final, y en
   * esa cola avanza menos de una decima de pixel por fotograma: mirando
   * solo el fotograma anterior parece parada cuando todavia se esta
   * colocando, el disco sale antes de tiempo y se le ve el PNG. Contra un
   * ancla fija ese arrastre lento se acumula hasta delatarse.
   *
   * Y se mide en coordenadas de documento, no de ventana: si no, hacer
   * scroll contaria como movimiento y el disco se escondia solo por
   * bajar la pagina. Se usa el rectangulo (no offsetTop) porque el sitio
   * mueve las portadas con transform, y eso offsetTop no lo ve.
   *
   * La espera se cuenta en MILISEGUNDOS, no en fotogramas. Contada en
   * fotogramas dura la mitad en una pantalla de 120Hz que en una de 60, y
   * entonces el disco asoma antes justo en las pantallas buenas. */
  var QUIETO = 700;            // ms clavada antes de dejar salir al disco
  var DERIVA = .05;            // px que puede apartarse del ancla
  var parada = 0, ancla = null, mirando = 0;

  /* Cuanto lleva la portada sin moverse. 0 = se esta moviendo ahora. */
  function asentada() {
    return parada > 0 && (Date.now() - parada) >= QUIETO;
  }

  /* El pestaneo: encoger y apagar a la vez, en un suspiro. Es como se
   * esconde SIEMPRE que la portada esta viajando. */
  function esconderRapido(v) {
    v.classList.add('is-moviendo');
    v.classList.remove('is-fuera');
    clearTimeout(guardando);
    // Para de girar cuando ya no se ve, no antes: frenar el plato en mitad
    // del fundido es otra cosa que se nota.
    guardando = setTimeout(function () { v.classList.remove('is-girando'); }, 250);
  }

  /* La columna de la portada actual. Dentro de .js-t-related la fila
   * lleva [<a> anterior, <div> actual, <a> siguiente]; el unico div nieto
   * es el del medio. En movil el sitio pinta otro componente sin
   * .js-t-related, y entonces no hay disco. */
  function columnaPortada() {
    var todas = document.querySelectorAll('.js-t-related');
    var rel = todas[todas.length - 1];
    return rel ? rel.querySelector(':scope > div > div') : null;
  }

  /* De los tres hijos de la columna, la portada es el mas alto: los otros
   * dos son las etiquetas de arriba y abajo. */
  function cajaPortada(col) {
    var mejor = null;
    for (var i = 0; i < col.children.length; i++) {
      var c = col.children[i];
      if (c === vinilo) continue;
      if (!mejor || c.offsetHeight > mejor.offsetHeight) mejor = c;
    }
    return mejor;
  }

  function medirVinilo() {
    if (!vinilo || !vinilo.parentNode) return;
    var caja = cajaPortada(vinilo.parentNode);
    if (!caja || !caja.offsetHeight) return;
    // El diametro es el lado MENOR de la portada: asi el disco cabe entero
    // detras y no asoma por los costados ni por abajo estando guardado.
    var d = Math.min(caja.offsetWidth, caja.offsetHeight);
    vinilo.style.width = d + 'px';
    vinilo.style.left = (caja.offsetLeft + caja.offsetWidth / 2) + 'px';
    vinilo.style.top = caja.offsetTop + 'px';
  }

  /* Se mete detras de la portada y se olvida de el.
   *
   * No se borra del DOM: al cambiar de caratula la portada vieja sigue en
   * pantalla un rato, viajando hacia el lado, y el disco tiene que irse
   * con ella y esconderse por el camino. Desaparece solo, cuando el sitio
   * retira ese panel.
   *
   * Se va SIEMPRE por el camino rapido, nunca retrayendose: aqui se llega
   * al salir al menu o al cambiar de caratula, y en los dos casos la
   * portada ya esta volando. Un disco retrayendose despacio encima de una
   * portada que se va es justo lo que canta que hay un PNG detras. La
   * retirada lenta y bonita es solo de la pausa, que pasa por otro sitio. */
  function quitarVinilo() {
    if (vinilo) esconderRapido(vinilo);
    vinilo = null;
    cancelAnimationFrame(mirando);
    mirando = 0;
    parada = 0;
    ancla = null;
  }

  /* Donde esta la portada en la pagina, inmune al scroll. */
  function sitioPortada(caja) {
    var r = caja.getBoundingClientRect();
    return {
      x: r.left + (window.pageXOffset || 0),
      y: r.top + (window.pageYOffset || 0),
      w: r.width,
      h: r.height
    };
  }

  /* Mira la portada fotograma a fotograma.
   *
   * Si se aparto del ancla, algo la esta animando: el disco se va en un
   * pestaneo —encogiendose y transparentandose a la vez—, porque cualquier
   * deslizamiento suyo se veria raro encima del de la portada. Cuando lleva
   * QUIETO fotogramas clavada, se remide (el sitio pudo dejarla de otro
   * tamano) y se deja salir. */
  function vigilar() {
    mirando = requestAnimationFrame(vigilar);
    if (!vinilo || !vinilo.parentNode) return;

    var caja = cajaPortada(vinilo.parentNode);
    if (!caja) return;
    var s = sitioPortada(caja);

    var movida = !ancla ||
      Math.abs(s.x - ancla.x) > DERIVA ||
      Math.abs(s.y - ancla.y) > DERIVA ||
      Math.abs(s.w - ancla.w) > DERIVA ||
      Math.abs(s.h - ancla.h) > DERIVA;

    if (movida) {
      ancla = s;               // el ancla solo se muda cuando de verdad se movio
      parada = 0;
      if (vinilo.classList.contains('is-fuera')) esconderRapido(vinilo);
    } else if (!parada) {
      parada = Date.now();     // acaba de quedarse quieta: empieza la cuenta
    } else if (!vinilo.classList.contains('is-fuera') && asentada()) {
      pintarVinilo();
    }
  }

  function montarVinilo() {
    var col = columnaPortada();
    if (!col) { quitarVinilo(); return; }
    if (vinilo && vinilo.parentNode === col) { medirVinilo(); return; }

    quitarVinilo();          // el de la portada anterior se guarda y se va

    vinilo = document.createElement('div');
    vinilo.className = 'tlb-vinilo';
    vinilo.setAttribute('aria-hidden', 'true');
    var img = document.createElement('img');
    img.className = 'tlb-vinilo__disco';
    img.src = BASE + '/vinilo.png';
    img.alt = '';
    vinilo.appendChild(img);

    // El primero de la columna: se pinta antes que la portada y por tanto
    // queda por detras de ella.
    col.insertBefore(vinilo, col.firstChild);
    medirVinilo();

    // Nace escondido. Sale solo cuando la portada lleve un rato quieta.
    parada = 0;
    ancla = null;
    vigilar();
  }

  function pintarVinilo() {
    if (!vinilo || !vinilo.parentNode) return;
    if (asentada() && sonando()) {
      clearTimeout(guardando);
      if (vinilo.classList.contains('is-moviendo')) {
        // Viene del pestaneo, encogido. Recupera su tamano EN SECO, todavia
        // escondido detras de la portada: lo que tiene que salir es un
        // disco deslizandose, no un disco creciendo.
        vinilo.style.transition = 'none';
        vinilo.classList.remove('is-moviendo');
        void vinilo.offsetWidth;                 // fuerza el reflow
        vinilo.style.transition = '';
      }
      medirVinilo();
      vinilo.classList.add('is-girando', 'is-fuera');
    } else if (vinilo.classList.contains('is-fuera')) {
      // Hay dos maneras de esconderse y equivocarse de una se nota mucho.
      // Si la portada esta quieta es una pausa: retirada lenta y visible.
      // Si se esta moviendo, estamos navegando y toca el pestaneo.
      //
      // Este caso pasa de verdad: pintar() corre en cada `timeupdate`,
      // cuatro veces por segundo, y cuando caia en mitad de una transicion
      // encontraba el disco fuera y lo mandaba a la retirada lenta antes de
      // que vigilar() llegara a esconderlo — y ya no lo escondia, porque
      // vigilar() solo actua sobre discos con is-fuera. Resultado: con la
      // portada volando, un segundo entero de disco opaco.
      if (!asentada()) { esconderRapido(vinilo); return; }

      vinilo.classList.remove('is-fuera');
      // Se guarda girando y solo entonces se para: un plato no frena en
      // seco, y coincide con la caida de tono del audio.
      clearTimeout(guardando);
      guardando = setTimeout(function () {
        if (vinilo) vinilo.classList.remove('is-girando');
      }, 1000);
    }
  }

  // ── el historial de la rocola ───────────────────────────────────
  //
  // La lista de cinco de arriba a la derecha ya no es una estampa que se
  // sortea al cargar y se queda quieta: es lo ultimo que ha sonado. La que
  // suena esta siempre la primera, y cualquier cosa que empiece —una fila
  // de esa lista, el boton de la cabecera, el play de una ficha— sube al
  // primer puesto y empuja a las demas hacia abajo.
  //
  // El bundle solo pone los mandos: construir.py deja en window.__tlbMenu
  // la lista, el indice, el <audio> de la rocola y su funcion de tocar
  // (ver historial_rocola). Las reglas se escriben aqui, que es donde se
  // pueden leer.

  function menu() { return window.__tlbMenu; }

  /* Las pistas se comparan por el nombre del archivo, no por la URL
   * entera: la misma pista aparece como ruta relativa en los datos del
   * menu, con prefijo en los nuestros y absoluta al leerla de un <audio>.
   * El nombre lo genera ident() y no se repite en todo el archivo. */
  function archivo(u) {
    if (!u) return '';
    var s = String(u).split('?')[0];
    return s.slice(s.lastIndexOf('/') + 1);
  }

  /* La pista que sigue a esta, con el criterio del disco y no el de la
   * lista: el corte siguiente del album y, si se acabo, el primero de la
   * caratula de al lado.
   *
   * `datos` conserva el orden en que construir.py recorrio las fichas, que
   * es el mismo con el que el sitio ordena las caratulas: "la de al lado"
   * significa aqui lo mismo que al pulsar la flecha dentro de una ficha. Y
   * las fichas sin audio no figuran, que es justo lo que hace falta. */
  function siguienteCorte(url) {
    var f = archivo(url);
    if (!datos || !f) return '';
    var slugs = Object.keys(datos);
    for (var i = 0; i < slugs.length; i++) {
      var cortes = datos[slugs[i]].cortes;
      for (var n = 0; n < cortes.length; n++) {
        if (archivo(cortes[n].url) !== f) continue;
        if (n + 1 < cortes.length) return cortes[n + 1].url;
        var sig = datos[slugs[(i + 1) % slugs.length]];
        return sig && sig.cortes.length ? sig.cortes[0].url : '';
      }
    }
    return '';
  }

  /* Que el reordenamiento se vea en vez de teletransportarse.
   *
   * Es el truco FLIP: se apunta donde esta cada fila ANTES de tocar la
   * lista, se deja que Vue reordene, y en el fotograma siguiente se le
   * pone a cada una la diferencia como desplazamiento y se la deja volver
   * a cero con una transicion. El navegador acaba animando algo que en el
   * DOM ya habia ocurrido de golpe.
   *
   * Funciona sin tocar el render porque el bundle pinta los <li> con
   * `key:f.id`: al reordenar, Vue MUEVE los mismos elementos en vez de
   * reescribir su contenido en el sitio. Por eso vale con guardar las
   * referencias a los nodos —siguen siendo validas despues— y no hay que
   * emparejar nada a mano.
   *
   * La lista es un desplegable que solo esta en pantalla mientras el raton
   * la ronda. Si no se ve, esto no hace nada: no por ahorrar, sino porque
   * un elemento oculto mide cero y las cuentas saldrian disparatadas. */
  var MOVER = .45;             // segundos que tarda una fila en llegar
  var CURVA = 'cubic-bezier(.19,1,.22,1)';   // la del sitio
  var reordenN = 0;

  function listaMenu() {
    var b = document.querySelector('button.group\\/track');
    var ul = b && b.closest && b.closest('ul');
    // offsetParent nulo = display:none, o sea desplegable cerrado.
    return ul && ul.offsetParent ? ul : null;
  }

  function animarReorden(hacer) {
    var quieto = window.matchMedia &&
                 window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var ul = quieto ? null : listaMenu();
    var viejas = ul ? [].slice.call(ul.children) : [];
    var antes = viejas.map(function (f) {
      return f.getBoundingClientRect().top;
    });

    hacer();

    if (!viejas.length) return;
    var mio = ++reordenN;

    requestAnimationFrame(function () {
      var mueve = [], entra = [], i;

      for (i = 0; i < viejas.length; i++) {
        var f = viejas[i];
        if (!f.parentNode) continue;            // esta se cayo de la lista
        var dy = antes[i] - f.getBoundingClientRect().top;
        if (!dy) continue;
        f.style.transition = 'none';
        f.style.transform = 'translateY(' + dy + 'px)';
        mueve.push(f);
      }

      // La que llega de fuera de las cinco no venia de ningun sitio: no
      // puede deslizarse desde una posicion que no tenia, asi que aparece.
      var ahora = listaMenu();
      var filas = ahora ? [].slice.call(ahora.children) : [];
      for (i = 0; i < filas.length; i++) {
        if (viejas.indexOf(filas[i]) !== -1) continue;
        filas[i].style.transition = 'none';
        filas[i].style.opacity = '0';
        entra.push(filas[i]);
      }

      void document.body.offsetWidth;           // un solo reflow para todas

      for (i = 0; i < mueve.length; i++) {
        mueve[i].style.transition = 'transform ' + MOVER + 's ' + CURVA;
        mueve[i].style.transform = '';
      }
      for (i = 0; i < entra.length; i++) {
        entra[i].style.transition = 'opacity ' + MOVER + 's linear';
        entra[i].style.opacity = '';
      }

      // Se limpia lo que hemos escrito, pero solo si entretanto no ha
      // empezado otro reordenamiento: si no, el temporizador del primero
      // le borraria los estilos al segundo a media animacion.
      setTimeout(function () {
        if (mio !== reordenN) return;
        var todas = mueve.concat(entra);
        for (var j = 0; j < todas.length; j++) {
          todas[j].style.transition = '';
          todas[j].style.transform = '';
          todas[j].style.opacity = '';
        }
      }, MOVER * 1000 + 60);
    });
  }

  /* Sube una pista al primer puesto y baja las demas. Si no estaba entre
   * las cinco entra igual y se cae la ultima. */
  function promover(url) {
    var m = menu();
    if (!m || !m.b || !url) return false;
    var f = archivo(url), todas = m.c.value || [], p = null;
    for (var i = 0; i < todas.length; i++) {
      if (todas[i] && todas[i].mp3 && archivo(todas[i].mp3.url) === f) {
        p = todas[i];
        break;
      }
    }
    if (!p) return false;
    var resto = [];
    for (var j = 0; j < m.b.value.length; j++) {
      if (m.b.value[j].id !== p.id) resto.push(m.b.value[j]);
    }
    animarReorden(function () {
      m.b.value = [p].concat(resto).slice(0, 5);
      m.i.value = 0;
    });
    return true;
  }

  /* Si esa pista es la que tiene cargada el <audio> de la ficha. */
  function enPropio(url) {
    return !!(propio && cargada && archivo(cargada) === archivo(url));
  }

  /* Si lo que suena es el <audio> de una ficha y no el de la rocola. Lo
   * pregunta el bundle antes de declararse en pausa: cuando una caratula
   * toma el relevo, la rocola se calla y su evento de pausa llega tarde,
   * cuando la ficha ya esta sonando. */
  function sonandoFuera() {
    return !!(propio && !propio.paused);
  }

  /* Play/pausa del <audio> de la ficha desde fuera de la ficha: la musica
   * no se para al salir de una caratula, asi que el mando de arriba tiene
   * que poder con ella aunque su ficha ya no este en pantalla. */
  function alternarPropio() {
    if (!propio) return;
    if (!propio.paused) frenar_plato(propio);
    else arrancar_plato(propio);
  }

  /* Pinchar una fila del historial. */
  function pincharRocola(p) {
    var m = menu();
    if (!m) return;
    var fila = m.b.value[p];
    if (!fila || !fila.mp3) return;
    var url = fila.mp3.url;

    // Si esa pista la esta tocando el <audio> de la ficha, el mando tiene
    // que ser ese. Pasarsela a la rocola arrancaria una segunda copia
    // desde cero mientras la primera se calla: aunque las dos sean "la
    // misma cancion", el minuto se pierde.
    if (enPropio(url)) { alternarPropio(); return; }

    // La que ya suena en la rocola: pausa. Al volver a darle sigue donde la
    // dejaste — antes empezaba de cero, ver historial_rocola en construir.py.
    if (p === m.i.value && !m.s.value) {
      if (m.t.value) m.t.value.pause();
      return;
    }

    m.s.value = false;
    promover(url);
    m.k();
  }

  /* Se acabo la pista: sigue el disco, no la lista. */
  function finRocola() {
    var m = menu();
    if (!m) return;
    var a = m.t.value;
    var sig = siguienteCorte(a && (a.currentSrc || a.src));
    if (!sig || !promover(sig)) { m.s.value = true; return; }
    m.s.value = false;
    m.k();
  }

  // ── interfaz ────────────────────────────────────────────────────

  function construir() {
    var raiz = document.createElement('div');
    raiz.className = 'tlb-rep';

    var cortes = '';
    if (disco.album) {
      for (var i = 1; i < disco.cortes.length; i++) {
        var pc = (disco.cortes[i].inicio / disco.total) * 100;
        cortes += '<span class="tlb-rep__corte" style="left:' + pc + '%"></span>';
      }
    }

    var indice = '';
    if (disco.album) {
      indice = '<ol class="tlb-rep__indice">';
      for (var j = 0; j < disco.cortes.length; j++) {
        var c = disco.cortes[j];
        var lado = c.lado ? c.lado + String(c.n) : String(j + 1);
        indice += '<li><button type="button" class="tlb-rep__fila" data-n="' + j + '">' +
          '<span class="tlb-rep__num">' + escapar(lado) + '</span>' +
          '<span class="tlb-rep__titulo">' + escapar(c.titulo) +
          (c.autor ? ' <span class="tlb-rep__autor">(' + escapar(c.autor) + ')</span>' : '') +
          '</span>' +
          '<span class="tlb-rep__min">' + reloj(c.inicio) + '</span>' +
          '</button></li>';
      }
      indice += '</ol>';
    }

    raiz.innerHTML =
      '<div class="tlb-rep__barra" role="slider" tabindex="0"' +
      ' aria-label="Posicion">' +
        '<div class="tlb-rep__riel"><div class="tlb-rep__relleno"></div></div>' +
        cortes +
        '<span class="tlb-rep__pomo"></span>' +
      '</div>' +
      '<div class="tlb-rep__mandos">' +
        '<button type="button" class="tlb-rep__boton" data-a="atras"' +
        ' aria-label="Anterior">' + svg(ICONO.atras) + '</button>' +
        '<button type="button" class="tlb-rep__boton tlb-rep__boton--tocar"' +
        ' data-a="tocar" aria-label="Reproducir">' + svg(ICONO.tocar) + '</button>' +
        '<button type="button" class="tlb-rep__boton" data-a="delante"' +
        ' aria-label="Siguiente">' + svg(ICONO.delante) + '</button>' +
        '<span class="tlb-rep__ahora"></span>' +
        '<span class="tlb-rep__t"></span>' +
      '</div>' + indice;

    ui = {
      raiz: raiz,
      barra: raiz.querySelector('.tlb-rep__barra'),
      relleno: raiz.querySelector('.tlb-rep__relleno'),
      pomo: raiz.querySelector('.tlb-rep__pomo'),
      tocar: raiz.querySelector('[data-a="tocar"]'),
      ahora: raiz.querySelector('.tlb-rep__ahora'),
      t: raiz.querySelector('.tlb-rep__t'),
      filas: raiz.querySelectorAll('.tlb-rep__fila')
    };

    raiz.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-a]');
      if (b) {
        ev.preventDefault();
        if (b.dataset.a === 'tocar') alternar();
        else if (b.dataset.a === 'atras') anterior();
        else siguiente();
        return;
      }
      var fila = ev.target.closest('.tlb-rep__fila');
      if (fila) {
        ev.preventDefault();
        var n = +fila.dataset.n;
        poner(n, true, 0, true);
      }
    });

    var arrastrando = false;
    function desdeRaton(ev) {
      var r = ui.barra.getBoundingClientRect();
      var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      irA((Math.max(0, Math.min(1, x / r.width))) * disco.total);
    }
    ui.barra.addEventListener('pointerdown', function (ev) {
      arrastrando = true;
      ui.barra.setPointerCapture(ev.pointerId);
      desdeRaton(ev);
    });
    ui.barra.addEventListener('pointermove', function (ev) {
      if (arrastrando) desdeRaton(ev);
    });
    ui.barra.addEventListener('pointerup', function () { arrastrando = false; });
    ui.barra.addEventListener('keydown', function (ev) {
      // Las flechas aqui mueven la aguja, no la caratula: si no se para
      // el evento, el sitio se lleva al visitante a la ficha vecina.
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        ev.stopPropagation();
        irA(posicion() + (ev.key === 'ArrowRight' ? 5 : -5));
      }
    });

    return raiz;
  }

  function pintar() {
    pintarVinilo();
    if (!ui || !disco) return;
    var pos = posicion();
    var pc = disco.total ? Math.max(0, Math.min(100, (pos / disco.total) * 100)) : 0;
    ui.relleno.style.width = pc + '%';
    ui.pomo.style.left = pc + '%';

    // Se escribe solo lo que de verdad cambio. Tocar el DOM en cada
    // timeupdate despertaba al MutationObserver de aqui abajo varias
    // veces por segundo para nada.
    var suena = sonando();
    ui.raiz.classList.toggle('is-sonando', suena);
    if (ui.sonaba !== suena) {
      ui.sonaba = suena;
      ui.tocar.innerHTML = svg(suena ? ICONO.pausa : ICONO.tocar);
      ui.tocar.setAttribute('aria-label', suena ? 'Pausa' : 'Reproducir');
    }

    var c = disco.cortes[idx];
    var rotulo = disco.album ? c.titulo : '';
    if (ui.ahora.textContent !== rotulo) ui.ahora.textContent = rotulo;
    var t = reloj(pos) + ' / ' + reloj(disco.total);
    if (ui.t.textContent !== t) ui.t.textContent = t;

    if (ui.marcada !== idx) {
      ui.marcada = idx;
      for (var i = 0; i < ui.filas.length; i++) {
        ui.filas[i].classList.toggle('is-actual', i === idx);
      }
    }
  }

  // ── montaje y cambios de ruta ───────────────────────────────────

  function desmontar() {
    if (ui && ui.raiz.parentNode) ui.raiz.parentNode.removeChild(ui.raiz);
    ui = null;
  }

  function montar() {
    var s = slugDeRuta();

    // Fuera de las fichas no hay reproductor. Lo propio se calla; lo de la
    // rocola se deja en paz, que para eso es de fondo.
    // Fuera de las fichas se quita la interfaz, pero la musica sigue: se
    // puede navegar por el archivo con el disco puesto, igual que con la
    // rocola. Solo se calla cuando eliges otra cosa.
    if (!s) {
      recordar();
      soltar(false);
      slug = null; disco = null;
      quitarVinilo();
      desmontar();
      return;
    }

    // Ficha sin audio: puede pasar encadenando, porque la mayoria del
    // archivo es solo portada.
    if (!datos || !datos[s]) {
      if (slug !== s) recordar();
      soltar(false);
      slug = s; disco = null;
      quitarVinilo();
      desmontar();
      return;
    }

    // El ULTIMO, no el primero: durante la transicion conviven el panel
    // que se va y el que entra, y el que entra se anade despues. Cogiendo
    // el primero se montaba en el saliente y, al desaparecer este, habia
    // que remontar a mitad de animacion: de ahi el salto.
    var todos = document.querySelectorAll('.js-t-content h1.js-t-title');
    if (!todos.length) todos = document.querySelectorAll('h1.js-t-title');
    var titulo = todos[todos.length - 1];
    if (!titulo) return;                       // aun no ha pintado

    var mismo = (s === slug);
    if (mismo && ui && ui.raiz.parentNode === titulo.parentNode) return;

    crearPropio();
    desmontar();

    if (!mismo) {
      recordar();                  // donde dejamos la ficha anterior
      soltar(false);
      // Aqui NO se para ni se descarga nada: lo que suene sigue sonando
      // aunque cambies de caratula. Lo que evita que el play de la nueva
      // reanude lo viejo es `cargada`, que se compara con el corte de
      // ESTA ficha antes de tocar nada.
      slug = s;
      disco = datos[s];
      var m = memoria[s] || { idx: 0, t: 0 };
      idx = Math.min(m.idx, disco.cortes.length - 1);
      pendiente = m.t;
    }

    // Se mete ya, para que el hueco este reservado desde el principio y el
    // texto no tenga que recolocarse a media animacion. Lo que se retrasa
    // es solo el verlo: entra difuminado detras del titulo, con la curva
    // del propio sitio.
    var nodo = construir();
    nodo.classList.add('tlb-rep--entra');
    titulo.parentNode.insertBefore(nodo, titulo.nextSibling);

    // Si la rocola ya venia sonando esta caratula, se adopta: la barra
    // arranca donde va la cancion, no en cero.
    montarVinilo();
    sincronizar();

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { nodo.classList.add('tlb-rep--dentro'); });
    });

    if (!mismo && seguir && !ajeno) {
      seguir = false;
      poner(0, true, 0, true);
    }
  }

  function arrancar() {
    montar();
    var pendiente = false;
    new MutationObserver(function () {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(function () { pendiente = false; montar(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', montar);
    window.addEventListener('resize', medirVinilo);

    // Cuando la rocola arranca algo, hay que mirar si es de esta ficha.
    document.addEventListener('play', function (ev) {
      if (ev.target.hasAttribute('data-tlb')) return;
      sincronizar();
      // Si no era de aqui, lo de esta ficha se calla: no pueden sonar dos.
      if (!ajeno && propio && !propio.paused) propio.pause();
    }, true);

    // Y al reves: si empieza lo de aqui, se calla la rocola.
    document.addEventListener('play', function (ev) {
      if (ev.target !== propio) return;
      var r = rocola();
      if (r && !r.paused) r.pause();
      // Lo que suene manda en el historial, venga de donde venga: dar al
      // play en una ficha tiene que subir esa pista al primer puesto de la
      // lista de arriba igual que si la hubieras pinchado alli.
      promover(cargada);
      var m = menu();
      if (m) m.s.value = false;
    }, true);

    // El historial tambien se tiene que enterar de que esto se paro. Pero
    // solo si no fue porque la rocola tomo el relevo: en ese caso el estado
    // bueno es el suyo, que ya se ha puesto solo, y pisarlo aqui dejaria la
    // lista diciendo "en pausa" con la musica sonando.
    document.addEventListener('pause', function (ev) {
      if (ev.target !== propio) return;
      var r = rocola();
      if (r && !r.paused) return;
      var m = menu();
      if (m) m.s.value = true;
    }, true);

    // Los mandos que el bundle desvia hacia aqui. Object.assign y no una
    // asignacion a secas porque el componente escribe en el mismo objeto y
    // no hay forma de saber cual de los dos llega primero.
    window.__tlbMenu = Object.assign(window.__tlbMenu || {}, {
      pinchar: pincharRocola,
      fin: finRocola,
      sonandoFuera: sonandoFuera
    });
  }

  fetch(BASE + '/reproductor.json')
    .then(function (r) { return r.json(); })
    .then(function (d) { datos = d; })
    .catch(function () { datos = {}; })
    .then(function () {
      if (document.body) arrancar();
      else document.addEventListener('DOMContentLoaded', arrancar);
    });
})();
