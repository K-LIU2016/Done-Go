// 组件页 harness 类型声明（M02 component.html 契约，见 smoke.spec.ts 头注）
export {};

declare global {
  interface Window {
    /** fixtures 深拷贝默认 props */
    __defaults(name: string): Record<string, unknown> | undefined;
    /** mount(#host, props)；置 window.__handle/__el；返回 handle */
    __mount(name: string, props: Record<string, unknown>): unknown;
    /** window.__handle.update(props) */
    __update(props: Record<string, unknown>): void;
    __handle?: { update(props: Record<string, unknown>): unknown } & Record<string, unknown>;
    __el?: HTMLElement;
    /** 测试内回调记录（spec 在浏览器侧定义） */
    __calls?: unknown[];
  }
}
