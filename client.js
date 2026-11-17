/**
 * dsh-conversation-identity — 浏览器半边：新建会话那一行的「身份」选择器。
 *
 * 注册进 `conversation.hero.options`（新建会话空状态那一行，右对齐、session 作用域）。
 * 语义上只在「开始一段新对话」时出现：选一个导入过的身份 + 强度档，这个会话就接着
 * 那段关系说话；已经开始聊的会话不会再来打扰。
 *
 * 读写都走宿主半边注册的 JSON 路由 `/conversation-identity/state`（同源相对 fetch）。
 * 颜色全部走宿主的 --dsw-alias-* 主题变量，跟随明暗主题。
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-identity',
  factory(require) {
    const reactModule = require('react');
    /** 平台种子可能给命名空间对象，两种形状都接受。 */
    const React = reactModule !== null && typeof reactModule === 'object' && typeof reactModule.createElement === 'function'
      ? reactModule
      : reactModule?.default;
    if (React === null || React === undefined || typeof React.createElement !== 'function') {
      throw new Error('dsh-conversation-identity: 浏览器模块表没有提供 react');
    }

    const PLUGIN_ID = 'dsh-conversation-identity';
    const CSS_ID = 'dsh-conversation-identity-style';
    const ROUTE = '/conversation-identity/state';
    const DELETE_ROUTE = '/conversation-identity/delete';
    const LABEL = '身份';

    const PURPOSE = '身份延续：选一个从聊天记录重建的身份，这个会话就接着那段关系说话。';

    const CSS = `
.dsh-idtn { position: relative; display: inline-flex; align-items: center; }
.dsh-idtn-chip {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  height: 28px; max-width: 220px; padding: 0 9px; margin: 0;
  border: 1px solid var(--dsw-alias-border-lighter); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 13px; line-height: 1; white-space: nowrap;
  cursor: pointer; transition: color .12s ease, border-color .12s ease, background-color .12s ease;
}
.dsh-idtn-chip:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-default); }
.dsh-idtn-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-idtn-chip:disabled { opacity: .6; cursor: default; }
.dsh-idtn-chip[data-on="on"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
.dsh-idtn-name { overflow: hidden; text-overflow: ellipsis; }
.dsh-idtn-caret { flex: none; font-size: 10px; opacity: .7; }
.dsh-idtn-menu {
  position: fixed; z-index: 2147483000; min-width: 260px; max-width: 340px;
  max-height: 60vh; overflow: auto; box-sizing: border-box;
  padding: 8px; border-radius: 10px;
  background: var(--dsw-alias-bg-elevated, #fff); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-light);
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  font-size: 13px;
}
.dsh-idtn-title { padding: 2px 6px 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-idtn-tiers { display: flex; gap: 6px; padding: 0 6px 8px; }
.dsh-idtn-tier {
  flex: 1; height: 26px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-lighter); background: transparent;
  color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px;
}
.dsh-idtn-tier[data-active="on"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.dsh-idtn-tier:disabled { opacity: .45; cursor: default; }
.dsh-idtn-flags { display: flex; gap: 14px; padding: 0 8px 8px; }
.dsh-idtn-row { display: flex; align-items: center; gap: 4px; }
.dsh-idtn-row .dsh-idtn-item { flex: 1; min-width: 0; }
.dsh-idtn-del {
  flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 1; cursor: pointer; opacity: .55;
}
.dsh-idtn-del:hover:not(:disabled) { opacity: 1; color: var(--dsw-alias-state-error-primary, #d4380d); }
.dsh-idtn-del:disabled { opacity: .3; cursor: default; }
.dsh-idtn-flag {
  display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 12px;
}
.dsh-idtn-flag[data-disabled="on"] { opacity: .45; cursor: default; }
.dsh-idtn-flag input { margin: 0; }
.dsh-idtn-item {
  display: block; width: 100%; box-sizing: border-box; text-align: left;
  padding: 8px; border: 0; border-radius: 8px; background: transparent;
  color: inherit; font-family: inherit; font-size: 13px; cursor: pointer;
}
.dsh-idtn-item:hover { background: var(--dsw-alias-bg-muted, rgba(127,127,127,.12)); }
.dsh-idtn-item[data-active="on"] { background: var(--dsw-alias-bg-muted, rgba(127,127,127,.12)); }
.dsh-idtn-item b { font-weight: 600; }
.dsh-idtn-sub { display: block; margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-idtn-hint { padding: 8px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dsh-idtn-sep { height: 1px; margin: 6px 4px; background: var(--dsw-alias-border-lighter); }
`;

    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return undefined;
      }
    }

    function failure(response, payload, fallback) {
      const message = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : fallback;
      const error = new Error(message);
      error.status = response.status;
      return error;
    }

    async function requestState(sessionId) {
      const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET', headers: { accept: 'application/json' } });
      const payload = await readJson(response);
      if (!response.ok) throw failure(response, payload, `HTTP ${response.status}`);
      if (payload?.ok !== true) throw failure(response, payload, '宿主返回了不成功的结果');
      return payload;
    }

    async function requestBind(sessionId, patch) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, ...patch }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw failure(response, payload, `HTTP ${response.status}`);
      if (payload?.ok !== true) throw failure(response, payload, '宿主返回了不成功的结果');
      return payload;
    }

    async function requestDelete(sessionId, identityId) {
      const response = await fetch(DELETE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, identityId }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw failure(response, payload, `HTTP ${response.status}`);
      if (payload?.ok !== true) throw failure(response, payload, '宿主返回了不成功的结果');
      return payload;
    }

    const INITIAL = Object.freeze({ phase: 'loading', data: null, note: '', tier: 'portrait', memory: true, anchors: true });

    /**
     * @param props - slot props；`sessionId` 标识当前（可能是空的）新会话。
     */
    function IdentityPicker(props) {
      const sessionId = props?.sessionId;
      const [state, setState] = React.useState(INITIAL);
      const [open, setOpen] = React.useState(false);
      const box = React.useRef({ mounted: false, seq: 0, saving: false, anchor: null });
      const chipRef = React.useRef(null);

      const read = React.useCallback(() => {
        const ref = box.current;
        if (sessionId === undefined || sessionId === null) return;
        ref.seq += 1;
        const seq = ref.seq;
        requestState(sessionId).then((payload) => {
          if (!ref.mounted || seq !== ref.seq) return;
          const bound = payload.binding;
          const found = Array.isArray(payload.identities) ? payload.identities.find((item) => item.identityId === bound?.identityId) : undefined;
          setState({
            phase: 'ready',
            data: payload,
            note: '',
            tier: bound?.strength ?? found?.strength ?? 'portrait',
            memory: bound === null || bound === undefined ? true : bound.memory !== false,
            anchors: bound === null || bound === undefined ? true : bound.anchors !== false,
          });
        }).catch((error) => {
          if (!ref.mounted || seq !== ref.seq) return;
          setState((previous) => ({ ...previous, phase: 'error', note: error?.message ?? String(error) }));
        });
      }, [sessionId]);

      React.useEffect(() => {
        const ref = box.current;
        ref.mounted = true;
        read();
        return () => {
          ref.mounted = false;
        };
      }, [read]);

      // 点外面关菜单；Esc 也关。
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const menu = document.getElementById(`${CSS_ID}-menu`);
          if (menu !== null && menu.contains(event.target)) return;
          if (chipRef.current !== null && chipRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      /**
       * 提交一次绑定变更。patch 里给什么改什么，没给的沿用当前状态。
       * @param {{identityId?: string|null, strength?: string, memory?: boolean, anchors?: boolean}} patch
       * @param {{close?: boolean}} options - 换身份/解绑后关菜单；改勾选和档位就不关
       */
      const commit = React.useCallback((patch, { close = true } = {}) => {
        const ref = box.current;
        if (sessionId === undefined || sessionId === null) return;
        if (ref.saving) return;
        const hasIdentity = Object.prototype.hasOwnProperty.call(patch, 'identityId');
        const identityId = hasIdentity ? patch.identityId : (state.data?.binding?.identityId ?? null);
        const tier = patch.strength ?? state.tier;
        const memory = patch.memory ?? state.memory;
        const anchors = patch.anchors ?? state.anchors;
        ref.saving = true;
        ref.seq += 1;
        const seq = ref.seq;
        setState((previous) => ({ ...previous, phase: 'saving', tier, memory, anchors }));
        requestBind(sessionId, { identityId, strength: tier, memory, anchors }).then((payload) => {
          if (!ref.mounted || seq !== ref.seq) return;
          const bound = payload.binding;
          const found = Array.isArray(payload.identities) ? payload.identities.find((item) => item.identityId === bound?.identityId) : undefined;
          setState({
            phase: 'ready',
            data: payload,
            note: '',
            tier: bound?.strength ?? found?.strength ?? tier,
            memory: bound === null ? memory : bound.memory !== false,
            anchors: bound === null ? anchors : bound.anchors !== false,
          });
          if (close) setOpen(false);
        }).catch((error) => {
          if (!ref.mounted || seq !== ref.seq) return;
          setState((previous) => ({ ...previous, phase: 'error', note: error?.message ?? String(error) }));
        }).finally(() => {
          ref.saving = false;
        });
      }, [sessionId, state.tier, state.memory, state.anchors, state.data]);

      /** 删除一张角色卡（会一起删掉它的记忆、原文与回放结果）。 */
      const remove = React.useCallback((identityId, name) => {
        if (sessionId === undefined || sessionId === null) return;
        const ref = box.current;
        if (ref.saving) return;
        const label = name === undefined || name === '' ? identityId : name;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(`删除角色卡「${label}」？\n会一起删掉它的记忆、原文与回放结果，不能撤销。`)) return;
        ref.saving = true;
        requestDelete(sessionId, identityId).then((payload) => {
          if (!ref.mounted) return;
          const bound = payload.binding;
          setState((previous) => ({
            phase: 'ready',
            data: payload,
            note: '',
            tier: bound?.strength ?? previous.tier,
            memory: bound === null ? previous.memory : bound.memory !== false,
            anchors: bound === null ? previous.anchors : bound.anchors !== false,
          }));
        }).catch((error) => {
          if (!ref.mounted) return;
          // 404/405 基本只有一个原因：宿主半边还是旧版（客户端刷新了、进程没重启）。
          const status = error?.status;
          const note = status === 404 || status === 405
            ? '删除接口未加载，需要完全退出重启 DSH'
            : (error?.message ?? String(error));
          setState((previous) => ({ ...previous, phase: 'error', note }));
        }).finally(() => {
          ref.saving = false;
        });
      }, [sessionId]);

      if (sessionId === undefined || sessionId === null) return null;

      const data = state.data;
      const identities = Array.isArray(data?.identities) ? data.identities : [];
      const binding = data?.binding ?? null;
      const boundName = binding === null ? '' : (identities.find((item) => item.identityId === binding.identityId)?.name ?? binding.identityId);
      const strengths = Array.isArray(data?.strengths) ? data.strengths : [
        { id: 'tone', label: '底色' },
        { id: 'portrait', label: '画像' },
        { id: 'standin', label: '替身' },
      ];
      const tierLabel = strengths.find((item) => item.id === state.tier)?.label ?? state.tier;
      /** 两个独立勾选：记忆与原文锚点。锚点只对替身档有意义，所以非替身档时置灰。 */
      const flagRows = [
        { key: 'memory', label: '带记忆', checked: state.memory, title: '把这段关系的事实一起注入（画像 / 替身档生效）' },
        { key: 'anchors', label: '带锚点', checked: state.anchors, title: '注入原文锚点（只对替身档生效）', disabled: state.tier !== 'standin' },
      ];

      let text;
      if (state.phase === 'loading') text = '身份（读取中）';
      else if (state.phase === 'error') text = `身份（${state.note}）`;
      else if (identities.length === 0) text = '身份：未导入';
      else if (binding === null) text = '身份：从头开始';
      else text = `身份：${boundName} · ${tierLabel}`;

      const toggle = () => {
        if (state.phase === 'loading' || state.phase === 'saving') return;
        if (state.phase === 'error' && data === null) {
          read();
          return;
        }
        setOpen((previous) => !previous);
      };

      const rect = chipRef.current === null ? null : chipRef.current.getBoundingClientRect();
      const menuStyle = rect === null ? { left: '16px', top: '16px' } : {
        left: `${Math.max(8, Math.min(rect.left, (window.innerWidth ?? 1024) - 348))}px`,
        top: `${Math.min(rect.bottom + 6, (window.innerHeight ?? 768) - 120)}px`,
      };

      return React.createElement(
        'div',
        { className: 'dsh-idtn' },
        React.createElement(
          'button',
          {
            type: 'button',
            ref: chipRef,
            className: 'dsh-idtn-chip',
            'data-on': binding === null ? 'off' : 'on',
            title: binding === null ? `${PURPOSE}\n当前：从头开始（不接任何导入的身份）` : `${PURPOSE}\n当前：${boundName} · ${tierLabel}`,
            'aria-label': text,
            disabled: state.phase === 'saving',
            onClick: toggle,
          },
          React.createElement('span', { key: 'label', className: 'dsh-idtn-name' }, text),
          React.createElement('span', { key: 'caret', className: 'dsh-idtn-caret', 'aria-hidden': true }, '▾'),
        ),
        open ? React.createElement(
          'div',
          {
            key: 'menu',
            id: `${CSS_ID}-menu`,
            className: 'dsh-idtn-menu',
            style: menuStyle,
            role: 'menu',
          },
          React.createElement('div', { className: 'dsh-idtn-title' }, '强度档（改档立即生效，不重新提炼、不花钱）'),
          React.createElement(
            'div',
            { className: 'dsh-idtn-tiers' },
            ...strengths.map((item) => React.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'dsh-idtn-tier',
                'data-active': state.tier === item.id ? 'on' : 'off',
                disabled: identities.length === 0,
                title: identities.length === 0
                  ? '还没有导入身份，先导入再选档位'
                  : `${item.label}：通过线 ${Math.round((item.threshold ?? 0) * 100)}%`,
                onClick: () => {
                  setState((previous) => ({ ...previous, tier: item.id }));
                  if (binding !== null) commit({ strength: item.id }, { close: false });
                },
              },
              item.label,
            )),
          ),
          ...(identities.length === 0
            ? [React.createElement('div', { key: 'empty', className: 'dsh-idtn-hint' }, '还没有导入身份。在对话里让我用 identity_import 导入一段聊天记录（平台导出或纯文本都行），建好后会出现在这里。')]
            : identities.map((item) => React.createElement(
              'div',
              { key: item.identityId, className: 'dsh-idtn-row' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-idtn-item',
                  'data-active': binding?.identityId === item.identityId ? 'on' : 'off',
                  onClick: () => commit({ identityId: item.identityId }),
                },
                React.createElement('b', null, item.name || '(未命名)'),
                React.createElement('span', { className: 'dsh-idtn-sub' }, `第 ${item.generation ?? 1} 代 · ${item.turns ?? 0} 轮${item.sampled ? ' · 抽样卡' : ''}`),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-idtn-del',
                  title: `删除角色卡「${item.name || item.identityId}」（连同记忆与原文）`,
                  'aria-label': `删除 ${item.name || item.identityId}`,
                  disabled: state.phase === 'saving',
                  onClick: () => remove(item.identityId, item.name),
                },
                '✕',
              ),
            ))),
          React.createElement(
            'div',
            { className: 'dsh-idtn-flags' },
            ...flagRows.map((flag) => React.createElement(
              'label',
              {
                key: flag.key,
                className: 'dsh-idtn-flag',
                'data-disabled': binding === null || flag.disabled === true ? 'on' : 'off',
                title: flag.title,
              },
              React.createElement('input', {
                type: 'checkbox',
                checked: flag.checked === true,
                disabled: binding === null || flag.disabled === true,
                onChange: () => commit({ [flag.key]: flag.checked !== true }, { close: false }),
              }),
              React.createElement('span', null, flag.label),
            )),
          ),
          React.createElement('div', { key: 'sep', className: 'dsh-idtn-sep' }),
          React.createElement(
            'button',
            {
              key: 'none',
              type: 'button',
              className: 'dsh-idtn-item',
              'data-active': binding === null ? 'on' : 'off',
              onClick: () => commit({ identityId: null }),
            },
            '从头开始（不接身份）',
          ),
        ) : null,
      );
    }

    function mountStyle() {
      if (typeof document === 'undefined') return () => {};
      if (document.getElementById(CSS_ID) !== null) return () => {};
      const style = document.createElement('style');
      style.id = CSS_ID;
      style.dataset.plugin = PLUGIN_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /**
     * @param ctx - 浏览器侧 Cordis 上下文。
     */
    function apply(ctx) {
      try {
        if (typeof ctx.effect === 'function') ctx.effect(mountStyle);
        else mountStyle();
        // slots.inject 自己会在 effect 里跑，并在 slot 声明变化时重跑；回调返回注册的 disposer。
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register(
          { name: 'conversation.hero.options', id: 'conversation-identity-picker', order: 40, label: LABEL },
          IdentityPicker,
        ));
        console.info('[identity] new-session picker registered');
      } catch (error) {
        console.error('[identity] apply failed:', error);
      }
    }

    return { inject: ['slots'], apply };
  },
});
