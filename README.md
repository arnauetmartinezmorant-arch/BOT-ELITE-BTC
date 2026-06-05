# BTC Quant Terminal 🟠

Terminal de análisis algorítmico de Bitcoin (BTC/USDT) con detección de patrones
multi-temporalidad, señales LONG/SHORT por confluencia, gestión de riesgo 2:1,
alertas sonoras + notificaciones y diario de trades.

> ⚠️ **Aviso**: Esto NO es asesoramiento financiero. Es una herramienta educativa.
> Ningún sistema acierta el 100% de las operaciones. Opera siempre con gestión de
> riesgo y nunca arriesgues lo que no puedas permitirte perder.

---

## ✨ Funcionalidades

- **Gráfico de velas en vivo** (TradingView Lightweight Charts) con EMAs y niveles.
- **Caja de posición estilo TradingView**: el trade completo se dibuja con una **zona verde (TP)** y una **zona roja (SL)** sobre el gráfico, con la línea de entrada.
- **Actualización en tiempo real (estilo TradingView)**: la vela actual se mueve en
  vivo mediante **streaming WebSocket** de Binance (con sondeo REST de respaldo si la
  conexión se bloquea). Indicadores, señal y cajas se refrescan solos. Cero botones.
- **7 temporalidades**: 1m, 5m, 15m, 1H, 4H, 1D, 1W.
- **Motor de señales por confluencia**: combina tendencia, EMAs, RSI, MACD,
  Estocástico, ADX, volumen, patrones y sesgo multi-temporalidad.
- **Planes de trade**: Entrada + Stop Loss (ATR + estructura) + TP1 (1:1) y TP2 (2:1).
- **Detección de patrones**: banderas, triángulos, velas japonesas, soportes/
  resistencias y **manipulación / barridos de liquidez** (stop hunts).
- **2 modos de riesgo (solo trades de confianza)**:
  - **Conservador** — buena confluencia, trades sólidos (por defecto).
  - **⭐ Premium** — ultra-selectivo: solo dispara con confluencia abrumadora
    (≥ 8/9 indicadores alineados + tendencia fuerte por ADX + marcos superiores a
    favor). Pensado para un par de trades A+ al día.
- **Pantalla completa del gráfico**: botón ⛶ para ver solo las velas a pantalla completa.
- **Mapa multi-temporalidad**: sesgo alcista/bajista en cada marco.
- **🔔 Alertas**: sonido (Web Audio) + notificaciones del navegador en cada señal nueva.
- **📓 Diario de trades**: registra operaciones, marca el resultado (TP2/TP1/SL/BE),
  P&L en vivo en R-múltiplos y estadísticas (win rate, R total, R medio). Se guarda
  en `localStorage`.

## 🗂️ Datos de mercado

Intenta obtener velas reales desde APIs públicas (Binance → Binance.US → OKX) directamente
desde tu navegador, sin API key. Si tu red las bloquea, usa un generador de datos
simulados realista para que la interfaz siempre funcione (verás "Simulado" en la cabecera).

---

## ▶️ Cómo abrirlo en local

La app usa **módulos ES (`import`/`export`)**, así que **no** puedes abrirla con doble
clic (`file://`) porque el navegador bloquea los módulos por seguridad (CORS).
Necesitas un pequeño servidor local. Elige UNA opción:

### Opción A — Python (suele venir preinstalado)
```bash
cd ruta/del/proyecto
python3 -m http.server 5500
```
Abre: http://localhost:5500

### Opción B — Node.js
```bash
cd ruta/del/proyecto
npx serve .
# o:  npx http-server -p 5500
```

### Opción C — VS Code
Instala la extensión **Live Server**, abre la carpeta, click derecho en
`index.html` → **Open with Live Server**.

> 💡 Para que las **notificaciones** funcionen, el navegador pedirá permiso la primera
> vez. El **sonido** se activa tras tu primera interacción con la página (política de
> autoplay de los navegadores).

---

## 📁 Estructura

```
index.html            Interfaz
css/styles.css        Estilos (tema oscuro premium, responsive)
js/
  app.js              Orquestación + gráfico + UI
  data.js             Capa de datos (Binance/OKX + fallback simulado)
  indicators.js       EMA, RSI, MACD, ATR, Bollinger, Estocástico, ADX, volumen
  patterns.js         Tendencia, S/R, banderas, triángulos, velas, manipulación
  signals.js          Motor de confluencia + planes de trade 2:1
  alerts.js           Sonido (Web Audio) + notificaciones
  journal.js          Diario de trades (localStorage) + estadísticas en R
server/               Bot de Telegram 24/7 (reutiliza js/ como motor)
  index.js            Bucle que escanea el mercado y envía señales
  config.js           Configuración por variables de entorno
  telegram.js         Envío a la API de Telegram
  format.js           Formato del mensaje de señal
  .env.example        Plantilla de configuración
package.json          Scripts: npm start (bot) · npm run selftest
```

---

## ⏱️ ¿Funciona 24/7?

Mientras la pestaña esté **abierta**, sí: el bot vigila el mercado en tiempo real,
actualiza las velas solo y te avisa con sonido + notificación cuando aparece una
señal nueva (incluso con la pestaña en segundo plano, el sistema mostrará la
notificación).

Pero ojo, esto es una **app de navegador**: si cierras el navegador o apagas el
ordenador, deja de vigilar. Para un **24/7 real** existe el **bot de Telegram**
(carpeta `server/`), que sí monitoriza con tu ordenador apagado. Ver abajo. 👇

---

## 🤖 Bot de Telegram 24/7 (un canal por modo)

En `server/` hay un bot de Node.js que reutiliza **exactamente el mismo motor de
análisis** que la web y envía las señales a Telegram, con **un canal por cada modo**
(Conservador, Premium). Así puedes seguir solo el modo que te interese.

### Puesta en marcha
1. **Crea el bot**: habla con [@BotFather](https://t.me/BotFather) → `/newbot` → copia el **token**.
2. **Crea 2 canales** en Telegram (uno por modo) y **añade tu bot como administrador** en cada uno.
3. Consigue el identificador de cada canal: el `@usuario` (canal público) o el `chat_id`
   numérico (privado, suele empezar por `-100…`).
4. Configura las variables de entorno (ver `server/.env.example`):
   ```bash
   export TELEGRAM_BOT_TOKEN="tu_token"
   export TELEGRAM_CHAT_CONSERVADOR="@tu_canal_conservador"
   export TELEGRAM_CHAT_PREMIUM="@tu_canal_premium"
   ```
5. Arranca:
   ```bash
   npm start
   ```
   Prueba sin enviar nada (imprime en consola):
   ```bash
   DRY_RUN=1 npm start
   # o el smoke test offline:
   npm run selftest
   ```

### Despliegue 24/7 (gratis)
Súbelo a **Render** o **Railway** como *Background Worker / Service*:
- Build: `npm install` (no hay dependencias, es instantáneo)
- Start: `npm start`
- Variables de entorno: las de arriba

### 🆓 Alternativa 100% gratis con GitHub Actions
El repo incluye `.github/workflows/telegram-bot.yml`, que escanea el mercado **cada 30
minutos** desde los servidores de GitHub (sin coste). Para activarlo:

1. En tu repo de GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
   Crea estos secretos (sin comillas):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_CONSERVADOR`
   - `TELEGRAM_CHAT_PREMIUM`
2. Ve a la pestaña **Actions**, acepta activar los workflows, y abre
   *"BTC Quant · Bot de Telegram (gratis)"* → **Run workflow** para probarlo al instante.
3. A partir de ahí corre solo cada 30 min. El estado se guarda en la caché de Actions,
   así que **no repite la misma señal** (solo avisa cuando cambia: p. ej. de nada a LONG).

> Notas: GitHub puede retrasar algún ciclo en horas punta; los workflows programados se
> pausan tras ~60 días sin actividad en el repo (entra y reactívalos). Para repos
> **públicos** los minutos de Actions son ilimitados; en privados tienes 2000/mes (de
> sobra para esto).

### Modo "una sola vez"
`RUN_ONCE=1 node server/index.js` ejecuta un único escaneo y termina (es lo que usa el
cron de GitHub Actions). Sin esa variable, corre en bucle continuo (Railway / tu PC).

El servicio escanea el mercado cada `CHECK_INTERVAL_SEC` segundos en las
temporalidades de `TIMEFRAMES`, y solo manda una señal por modo cuando se cumplen
sus condiciones (no repite la misma antes de `COOLDOWN_MIN` minutos). Cada modo
publica en **su** canal, con entrada, SL, TP1, TP2 (2:1), convicción e indicadores
alineados.

> ⚠️ Solo envía señales con **datos reales**; si la API de mercado no está disponible
> ese ciclo se omite (no inventa señales).

---

## 🧠 Cómo decide el bot

Cada factor (tendencia, momentum, RSI, MACD, patrones, niveles, sesgo de marcos
superiores...) aporta un peso con dirección alcista o bajista. La suma da una
**puntuación de confluencia** y un **% de convicción**. El bot **solo** propone un
trade si ambos superan el umbral del modo de riesgo elegido; si no, muestra
**"SIN TRADE"**. Por eso la mayoría del tiempo espera: la disciplina es la ventaja.

---

Hecho con 🧡 para fines educativos.
