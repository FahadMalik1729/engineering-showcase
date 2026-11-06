import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Selection, SortDescriptor } from 'react-aria-components';
import { Table, TableHeader, TableBody, Column, Row, Cell } from '@/shared/ui/table';
import { Checkbox } from '@/shared/ui/checkbox';
import { Pagination } from '@/shared/ui/pagination';
import { QueryBoundary } from '@/shared/ui/query-boundary';
import { Button } from '@/shared/ui/button';
import { Stack } from '@/shared/ui/stack';
import { Toolbar } from '@/shared/ui/toolbar';
import { DataRegion } from '@/shared/ui/data-region';
import { cn } from '@/shared/lib/cn';
import { Link } from '@/shared/ui/link';
import { Switch } from '@/shared/ui/switch';
import { EfficaFormDialog, type EfficaGridDetailsTab } from './EfficaFormDialog';
import type { EfficaFormProps } from './EfficaForm';
import { GridFilterBar } from './GridFilterBar';
import { GridSearchToggle } from './GridSearchToggle';
import { GridSearchField } from './GridSearchField';
import { GridExplicitFilters, type GridExplicitFilter } from './GridExplicitFilters';
import { filterableColumns, resolveSearchFields, buildSearchFilters } from '../lib/gridFilters';
import { columnLayout } from '../lib/gridColumnLayout';
import { mergeDetailsTabs } from '../lib/detailsTabs';
import { interpolateFilters, interpolateTemplate } from '../lib/interpolate';
import { toDisplayString } from '../lib/formatCellValue';
import { buildDataTestId, useDataTestId } from '../lib/dataTestId';
import type { FormMode } from '../schemas/formMetadataSchemas';
import type { GridColumnMetadata } from '../schemas/metadataSchemas';
import { useGridMetadata } from '../hooks/useGridMetadata';
import { useGridData } from '../hooks/useGridData';
import {
  useGridLocalState,
  useGridUrlState,
  type GridState,
  type SetGridState,
} from '../hooks/gridState';
import { useFormatCellValue } from '../hooks/useFormatCellValue';
import type { Filters, GridMetadata, GridRow, Sort } from '../schemas/metadataSchemas';

// ---------------------------------------------------------------------------
// EfficaGrid — metadata-driven data grid for any registered Effica entity.
//
// The component is self-sufficient: given an entity name it fetches its own
// grid metadata (GET /api/v1/entities/grid/:entity) and pages of data
// (POST …/data) with server-side pagination and sorting. Consumers declare
// WHAT to show, never HOW to fetch it:
//
//   <EfficaGrid entity="audit-notifications" />
//   <EfficaGrid entity="vitals" filters={[{ key: 'clientId', op: 'eq', value: id }]} />
// ---------------------------------------------------------------------------

/**
 * What `onSelectionChange` reports. Deliberately a discriminated union rather
 * than a bare `string[] | 'ALL'` sentinel: `'ALL'.length === 3`, so a caller
 * writing the natural `selection.length < 2` against a sentinel would compile,
 * run, and be silently wrong. Forcing `.mode` makes that impossible, and
 * `.count` means the common enable/disable check is mode-agnostic.
 */
export type GridSelection =
  { mode: 'ids'; ids: string[]; count: number } | { mode: 'all'; count: number };

export interface EfficaGridProps {
  /** Registered metadata entity key, e.g. 'clients', 'audit-notifications'. */
  entity: string;
  /** Static base filters, AND-ed server-side with any future user filters. */
  filters?: Filters;
  /** Overrides the metadata label as the grid heading. */
  title?: string;
  /** Render the heading (default true). */
  showTitle?: boolean;
  /** Render the pagination footer (default true). */
  showPagination?: boolean;
  /** Render the user filter bar when the metadata has filterable columns (default true). */
  showFilterBar?: boolean;
  /**
   * Controls the search/filter toolbar:
   * - `'dynamic'` (default): global search plus the metadata-driven filter
   *   builder, switched by a toggle.
   * - `'search'`: only the global search input.
   * - `GridExplicitFilter[]`: the global search input alongside a fixed set of
   *   declared dropdown filters (each `{ field, label, options, op? }`).
   *   Multiple filters are AND-ed.
   */
  filterMode?: 'dynamic' | 'search' | GridExplicitFilter[];
  /**
   * Enable the global search input (a toggle switches between it and the
   * structured filter bar). Defaults to true when search fields resolve.
   */
  enableSearch?: boolean;
  /**
   * Declarative set of column fieldKeys the global search runs over
   * (`contains`, OR-ed). Omit to default to every visible string/text
   * filterable column.
   */
  searchFields?: string[];
  /**
   * Keep page/sort state in the URL (default true, §5A). Set false for
   * router-less contexts (Storybook) or grids inside dialogs.
   */
  syncToUrl?: boolean;
  /** Namespaces URL params (`<prefix>page`) when a page hosts several grids. */
  paramPrefix?: string;
  /**
   * Row click opens the built-in EfficaForm edit dialog and an "Add new"
   * button is shown. An explicit `onRowClick` takes precedence for rows.
   */
  withEditDialog?: boolean;
  /** Show the "Add new" button (default true when withEditDialog). */
  canAddNew?: boolean;
  /** Render the "Add new" button disabled (visible but inert). */
  newDisabled?: boolean;
  /** Overrides the "Add new" button label. */
  newLabel?: string;
  /**
   * Explicit tab set for the details dialog. A `type: 'form'` entry is the
   * built-in EfficaForm details tab (its `formProps` override the form,
   * including `dataService`); `type: 'custom'` entries render arbitrary
   * content and receive the selected object via DetailsTabContext.
   */
  detailsTabs?: EfficaGridDetailsTab[];
  /** Base EfficaForm overrides for the dialog's form tab(s). */
  formProps?: Partial<EfficaFormProps>;
  onRowClick?: (row: GridRow) => void;
  /**
   * Adds a leading checkbox column for multi-row selection. Rows are keyed by
   * primary key, so the selection SURVIVES PAGING — ticking rows on page 1,
   * moving to page 2 and back keeps them ticked. Requires the metadata to
   * declare a primary key; without one the column is not rendered.
   *
   * Row click still opens the edit dialog: selection is checkbox-only
   * (`selectionBehavior="toggle"` + `onAction`), so the two never conflict.
   */
  enableMultiSelect?: boolean;
  /**
   * Which column's value `onSelectionChange` reports per selected row.
   * Defaults to the primary key.
   *
   * This changes only the value handed BACK to you. Row identity — what the
   * grid uses to track selection across pages — is always the primary key, so
   * naming a non-unique column here (a status, a code) cannot corrupt the
   * selection or make two rows toggle together. Rows whose value is null fall
   * back to the primary key rather than emitting "null".
   */
  selectionField?: string;
  /**
   * Fires on every selection change — tick, untick, select-all, and clear.
   *
   * Two modes, because with server-side pagination the ids of rows you have
   * never fetched cannot be enumerated:
   * - `ids`  — the caller gets the explicit primary keys.
   * - `all`  — the header checkbox was used. No ids are sent; the caller is
   *            expected to act on "everything matching the current filters"
   *            server-side (a `DELETE …?filter=` rather than an id list).
   *
   * `count` is populated in BOTH modes (in `all` it is the server's total for
   * the active filters), so button enable/disable logic never has to branch.
   */
  onSelectionChange?: (selection: GridSelection) => void;
  className?: string;
  view?: string;
}

export function EfficaGrid({ syncToUrl = true, ...props }: EfficaGridProps) {
  // URL state needs the router context; local state must not conditionally
  // call useSearchParams — so the strategy choice happens at component level.
  return syncToUrl ? <UrlStateGrid {...props} /> : <LocalStateGrid {...props} />;
}

type StatelessGridProps = Omit<EfficaGridProps, 'syncToUrl'>;

function UrlStateGrid({ paramPrefix = '', ...props }: StatelessGridProps) {
  const [state, setState] = useGridUrlState(paramPrefix);
  return <GridWithMetadata {...props} state={state} setState={setState} />;
}

function LocalStateGrid(props: StatelessGridProps) {
  const [state, setState] = useGridLocalState();
  return <GridWithMetadata {...props} state={state} setState={setState} />;
}

interface GridStateProps {
  state: GridState;
  setState: SetGridState;
}

function GridWithMetadata({
  entity,
  state,
  setState,
  ...props
}: StatelessGridProps & GridStateProps) {
  const metaQuery = useGridMetadata(entity, props.view);
  return (
    <QueryBoundary query={metaQuery}>
      {(meta) => (
        <GridContent entity={entity} meta={meta} state={state} setState={setState} {...props} />
      )}
    </QueryBoundary>
  );
}

interface EditDialogState {
  mode: FormMode;
  /**
   * Primary-key value of the row being edited. The dialog fetches the FULL
   * record via the form-data endpoint — grid rows only carry grid columns
   * (form-only fields like long text are omitted from grid queries).
   */
  id?: number;
  /** Fallback initial values when the grid metadata exposes no primary key. */
  record?: GridRow;
  /** The clicked grid row — used to interpolate details-tab templates. */
  row?: GridRow;
}

function GridContent({
  entity,
  meta,
  view,
  filters,
  title,
  showTitle = true,
  showPagination = true,
  showFilterBar = true,
  filterMode = 'dynamic',
  enableSearch = true,
  searchFields,
  withEditDialog = false,
  canAddNew = true,
  newDisabled = false,
  newLabel,
  detailsTabs,
  formProps,
  onRowClick,
  enableMultiSelect = false,
  selectionField,
  onSelectionChange,
  className,
  state,
  setState,
}: StatelessGridProps & GridStateProps & { meta: GridMetadata }) {
  const { t } = useTranslation();
  // Locale + display timezone bound implicitly (app-shell i18n / org context).
  const formatCell = useFormatCellValue();
  // Scoped data-testid builder for QA. Every id resolves as
  // <portal>.<entity>.grid.<element>[.<id>]; portal comes from the active
  // session (see lib/dataTestId.ts).
  const dataId = useDataTestId(entity);
  const [editDialog, setEditDialog] = useState<EditDialogState | null>(null);
  // Search vs. filter is a UI toggle; start in search when a term is present
  // (e.g. from a shared URL).
  const [searchMode, setSearchMode] = useState(() => state.search.trim().length > 0);

  const columns = useMemo(
    () =>
      meta.columns
        .filter((column) => column.isVisible !== false)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [meta.columns],
  );
  // Per-column sizing: explicit metadata width, else a dataType default.
  const layouts = useMemo(
    () => new Map(columns.map((column) => [column.fieldKey, columnLayout(column)])),
    [columns],
  );
  const primaryKey = meta.columns.find((column) => column.isPrimary)?.fieldKey;

  // Multi-select needs a stable row identity to survive paging, so it is only
  // active when the metadata declares a primary key. `selectedRows` is the
  // master set across ALL pages; the Table itself is only ever handed the
  // subset present on the current page (RAC ignores keys outside its
  // collection), and page transitions merge rather than replace.
  const selectionEnabled = enableMultiSelect && Boolean(primaryKey);
  // Keyed by primary key (identity) → the value we report back (whatever
  // `selectionField` names). Keeping identity and reported value in one map is
  // what lets a row selected on page 1 still contribute its value after you
  // page away and its row object is gone.
  const [selectedRows, setSelectedRows] = useState<Map<string, string>>(() => new Map());
  // `all` is a MODE, not an expanded id list — that is the whole point, since
  // rows on unfetched pages have no ids to collect. Handing RAC the literal
  // 'all' also makes every row render ticked on every page for free.
  const [allSelected, setAllSelected] = useState(false);

  const pageSize = state.pageSize ?? meta.pageSize ?? 15;
  // URL sort wins; otherwise the metadata's default sort applies.
  const effectiveSort: Sort | undefined = state.sort
    ? { field: state.sort, dir: state.dir }
    : meta.defaultSort?.[0];

  const availableSearchFields = useMemo(
    () => resolveSearchFields(columns, searchFields),
    [columns, searchFields],
  );
  // Toolbar mode: 'dynamic' (search + filter builder toggle), 'search' (search
  // only), or an explicit set of declared dropdown filters (search + filters).
  const explicitFilters = Array.isArray(filterMode) ? filterMode : null;
  const hasExplicit = explicitFilters != null;
  const dynamicMode = filterMode === 'dynamic';

  const searchAvailable = enableSearch && availableSearchFields.length > 0;
  // The metadata-driven filter builder only appears in dynamic mode.
  const structuredFilterAvailable =
    dynamicMode && showFilterBar && filterableColumns(columns).length > 0;
  // Resolve which control is active: the toggle only matters when both are
  // available; otherwise whichever exists.
  const activeMode: 'search' | 'filter' = !searchAvailable
    ? 'filter'
    : !structuredFilterAvailable
      ? 'search'
      : searchMode
        ? 'search'
        : 'filter';

  // Search and column filters contribute to the query. In dynamic mode search
  // and the filter builder are alternatives (whichever is active); with
  // explicit filters, search AND the dropdown selections both apply. Base
  // filters (prop) always apply.
  const effectiveFilters = useMemo(() => {
    const searchFilters = searchAvailable
      ? buildSearchFilters(availableSearchFields, state.search)
      : [];
    const active = hasExplicit
      ? [...searchFilters, ...state.filters]
      : activeMode === 'search'
        ? searchFilters
        : state.filters;
    return [...(filters ?? []), ...active];
    // `hasExplicit` (a boolean) stands in for the explicit-filter array, whose
    // selections actually live in state.filters — so its identity is irrelevant.
  }, [
    filters,
    state.filters,
    state.search,
    activeMode,
    availableSearchFields,
    searchAvailable,
    hasExplicit,
  ]);

  const dataQuery = useGridData(entity, {
    page: state.page - 1,
    pageSize,
    sorts: effectiveSort ? [effectiveSort] : undefined,
    filters: effectiveFilters,
    view,
  });

  const sortDescriptor: SortDescriptor | undefined = effectiveSort
    ? {
        column: effectiveSort.field,
        direction: effectiveSort.dir === 'asc' ? 'ascending' : 'descending',
      }
    : undefined;

  const handleSortChange = (descriptor: SortDescriptor) => {
    setState({
      sort: String(descriptor.column),
      dir: descriptor.direction === 'ascending' ? 'asc' : 'desc',
      page: 1,
    });
  };

  const heading = title ?? meta.label;

  const handleRowAction =
    onRowClick ??
    (withEditDialog
      ? (row: GridRow) => {
          const idValue = primaryKey ? Number(row[primaryKey]) : Number.NaN;
          setEditDialog(
            Number.isFinite(idValue)
              ? { mode: 'edit', id: idValue, row }
              : { mode: 'edit', record: row, row },
          );
        }
      : undefined);

  // Server-declared details tabs (@GridDetailsTabs on the entity) become the
  // BASE tab set: 'form' entries are the built-in details form; 'grid'
  // entries render a nested EfficaGrid over the related entity, with the tab
  // name and filter values '{field}'-interpolated against the clicked row.
  // Consumer `detailsTabs` then merge over the base (override by key, a form
  // tab replaces the details tab, everything else appends at the end).
  const dialogTabs = useMemo<EfficaGridDetailsTab[]>(() => {
    const row = editDialog?.row;
    const serverTabs = [...(meta.details?.tabs ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map<EfficaGridDetailsTab>((tab, index) => {
        const label = interpolateTemplate(tab.name, row) || t('metadata.form.detailsTab');
        if (tab.type === 'form') {
          return {
            key: index === 0 ? 'details' : `form-${tab.entityName}`,
            label,
            type: 'form',
            // Server-declared identity for the tab's data-testid, regardless of
            // the React key we picked for RAC.
            dataIdKey: tab.entityName,
          };
        }
        return {
          key: tab.entityName,
          label,
          type: 'custom',
          dataIdKey: tab.entityName,
          render: () => (
            <EfficaGrid
              entity={tab.entityName}
              filters={interpolateFilters(tab.filters, row)}
              syncToUrl={false}
              showTitle={false}
              // Rows in a details grid tab open the related entity's
              // EfficaForm (row click → edit, "Add new" → create).
              withEditDialog
            />
          ),
        };
      });
    const base: EfficaGridDetailsTab[] =
      serverTabs.length > 0
        ? serverTabs
        : [{ key: 'details', label: t('metadata.form.detailsTab'), type: 'form' }];
    return mergeDetailsTabs(base, detailsTabs);
  }, [meta.details, editDialog?.row, detailsTabs, t]);

  const modeToggle =
    searchAvailable && structuredFilterAvailable ? (
      <GridSearchToggle
        mode={activeMode}
        onChange={(next) => {
          setSearchMode(next === 'search');
          setState({ page: 1 });
        }}
        dataIdScope={dataId('grid')}
      />
    ) : undefined;

  const filterControls =
    activeMode === 'filter' && structuredFilterAvailable ? (
      <GridFilterBar
        columns={columns}
        filters={state.filters}
        onChange={(nextFilters) => {
          setState({ filters: nextFilters, page: 1 });
        }}
        dataIdScope={dataId('grid')}
      />
    ) : undefined;

  // Declared dropdown filters (explicit mode) sit alongside the search field.
  const explicitControls = explicitFilters ? (
    <GridExplicitFilters
      filters={explicitFilters}
      value={state.filters}
      onChange={(nextFilters) => {
        setState({ filters: nextFilters, page: 1 });
      }}
      dataIdScope={dataId('grid')}
    />
  ) : undefined;

  // Toggle + (in filter mode) the filter bar, or the explicit dropdowns, share
  // the toolbar's filters slot; the search field takes the dedicated search slot.
  const filtersSlot =
    modeToggle || filterControls || explicitControls ? (
      <div className="flex flex-wrap items-center gap-2">
        {modeToggle}
        {filterControls}
        {explicitControls}
      </div>
    ) : undefined;

  // Search shows in its own modes ('search' toggle in dynamic mode) and always
  // in search-only / explicit modes.
  const showSearchField =
    searchAvailable && (explicitFilters != null || !dynamicMode || activeMode === 'search');
  const searchSlot = showSearchField ? (
    <GridSearchField
      value={state.search}
      onCommit={(term) => {
        setState({ search: term, page: 1 });
      }}
      dataIdScope={dataId('grid')}
    />
  ) : undefined;

  const addNewAction =
    withEditDialog && canAddNew ? (
      <Button
        variant="primary"
        size="sm"
        isDisabled={newDisabled}
        data-testid={dataId('grid', 'addNew', 'button')}
        onPress={() => {
          setEditDialog({ mode: 'create' });
        }}
      >
        {newLabel ?? t('metadata.grid.addNew')}
      </Button>
    ) : undefined;

  return (
    <Stack gap="md" className={className} data-testid={dataId('grid', 'container')}>
      {showTitle ? <h2 className="font-heading text-lg font-semibold text-fg">{heading}</h2> : null}

      {/* Canonical top-of-table control row: search / filters wrap freely,
          the primary list action is pushed to the end on md+ (§Toolbar).
          Wrapped in a white surface card so it reads as a distinct control
          band above the data grid. */}
      {searchSlot || filtersSlot || addNewAction ? (
        <div className="rounded-2xl border border-border bg-surface p-3 shadow-sm">
          <Toolbar
            search={searchSlot}
            filters={filtersSlot}
            actions={addNewAction}
            className="md:items-start"
          />
        </div>
      ) : null}

      <QueryBoundary query={dataQuery}>
        {({ data, pagination }) => {
          const pageCount = Math.max(1, Math.ceil(pagination.total / pageSize));

          // Row ids for the rows currently on screen. `pageSelection` narrows
          // the master set to those, which is all RAC may legally receive.
          const rowIdAt = (row: GridRow, index: number) =>
            primaryKey ? String(row[primaryKey]) : String(index);
          // The reported value. Falls back to the row id when the chosen field
          // is absent or null, so callers never receive the string "null".
          const rowValueAt = (row: GridRow, index: number) => {
            const field = selectionField ?? primaryKey;
            const value = field ? row[field] : undefined;
            // toDisplayString, not String() — cell values are arbitrary JSON
            // and a raw object would stringify to "[object Object]".
            return value == null ? rowIdAt(row, index) : toDisplayString(value);
          };
          const pageIds = data.map(rowIdAt);
          const pageSelection = new Set(pageIds.filter((id) => selectedRows.has(id)));

          const handleSelectionChange = (keys: Selection) => {
            // Header checkbox → enter `all` mode. We deliberately do NOT
            // expand it into this page's ids: the caller acts on the filter,
            // not on a list, and `pagination.total` is the real count.
            if (keys === 'all') {
              setAllSelected(true);
              setSelectedRows(new Map());
              onSelectionChange?.({ mode: 'all', count: pagination.total });
              return;
            }

            // Any tick/untick while `all` is active exits the mode outright
            // and clears. Adopting RAC's incoming set instead would silently
            // collapse "all 57" down to "this page minus one" — a wrong count
            // that looks plausible. All-or-nothing is the honest simple rule;
            // preserving it as all-except-N needs an exclusion list.
            if (allSelected) {
              setAllSelected(false);
              setSelectedRows(new Map());
              onSelectionChange?.({ mode: 'ids', ids: [], count: 0 });
              return;
            }

            // Merge rather than replace: drop this page's ids from the master
            // map, then re-add whatever RAC reports. Selections made on other
            // pages are untouched, so paging never loses them.
            const next = new Map(selectedRows);
            pageIds.forEach((id) => next.delete(id));
            keys.forEach((key) => {
              const id = String(key);
              const index = pageIds.indexOf(id);
              // RAC only ever reports keys from the current page, so the row
              // object is in hand and its reported value can be captured now —
              // it must outlive paging away from this page.
              if (index >= 0) next.set(id, rowValueAt(data[index]!, index));
            });
            setSelectedRows(next);
            onSelectionChange?.({ mode: 'ids', ids: [...next.values()], count: next.size });
          };

          return (
            <>
              <DataRegion
                className={cn('transition-opacity', dataQuery.isPlaceholderData && 'opacity-60')}
              >
                <Table
                  aria-label={heading}
                  sortDescriptor={sortDescriptor}
                  onSortChange={handleSortChange}
                  // 'toggle' + a row onAction is what keeps click-to-open and
                  // checkbox-to-select from fighting each other.
                  selectionMode={selectionEnabled ? 'multiple' : undefined}
                  selectionBehavior={selectionEnabled ? 'toggle' : undefined}
                  selectedKeys={
                    selectionEnabled ? (allSelected ? 'all' : pageSelection) : undefined
                  }
                  onSelectionChange={selectionEnabled ? handleSelectionChange : undefined}
                  // Dense grid body font (~13px); overrides the shared Table's
                  // text-sm via tailwind-merge. Headers keep their own size.
                  className="text-grid"
                >
                  <TableHeader>
                    {selectionEnabled ? (
                      <Column id="__selection" style={{ width: 44 }} className="pl-3">
                        <Checkbox
                          slot="selection"
                          aria-label={t('metadata.grid.selectAll')}
                          data-testid={dataId('grid', 'selectAll', 'checkbox')}
                        />
                      </Column>
                    ) : null}
                    {columns.map((column, index) => (
                      <Column
                        key={column.fieldKey}
                        id={column.fieldKey}
                        isRowHeader={index === 0}
                        allowsSorting={column.isSortable !== false}
                        style={layouts.get(column.fieldKey)?.style}
                        className="whitespace-nowrap"
                        data-testid={dataId('grid', 'column', column.fieldKey, 'header')}
                      >
                        <span className="inline-flex items-center gap-1">
                          {column.label}
                          {effectiveSort?.field === column.fieldKey ? (
                            <SortArrow dir={effectiveSort.dir} />
                          ) : null}
                        </span>
                      </Column>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {data.map((row, rowIndex) => {
                      const rowKey = rowIdAt(row, rowIndex);
                      const rowDataId = dataId('grid', 'row', rowKey);
                      return (
                        <Row
                          key={rowKey}
                          id={rowKey}
                          onAction={handleRowAction ? () => handleRowAction(row) : undefined}
                          className={handleRowAction ? 'cursor-pointer' : undefined}
                          data-row-id={primaryKey ? toDisplayString(row[primaryKey]) : undefined}
                          data-testid={rowDataId}
                        >
                          {selectionEnabled ? (
                            <Cell style={{ width: 44 }} className="pl-3">
                              <Checkbox
                                slot="selection"
                                aria-label={t('metadata.grid.selectRow')}
                                data-testid={buildDataTestId(rowDataId, 'selection', 'checkbox')}
                              />
                            </Cell>
                          ) : null}
                          {columns.map((column) => {
                            const layout = layouts.get(column.fieldKey);
                            const cellDataId = buildDataTestId(rowDataId, 'cell', column.fieldKey);
                            return (
                              <Cell
                                key={column.fieldKey}
                                data-field={column.fieldKey}
                                style={layout?.style}
                                className={cn(
                                  'whitespace-nowrap',
                                  layout?.truncate && 'overflow-hidden text-ellipsis',
                                )}
                                data-testid={cellDataId}
                              >
                                <GridCellContent
                                  column={column}
                                  row={row}
                                  text={formatCell(row[column.fieldKey], column.dataType)}
                                  dataIdScope={cellDataId}
                                />
                              </Cell>
                            );
                          })}
                        </Row>
                      );
                    })}
                  </TableBody>
                </Table>
                {data.length === 0 ? (
                  <div
                    className="flex flex-col items-center gap-1 px-4 py-10 text-center"
                    data-testid={dataId('grid', 'emptyState')}
                  >
                    <p className="font-medium text-fg">
                      {t('metadata.grid.emptyTitle', { entity: heading })}
                    </p>
                    <p className="text-sm text-muted">{t('metadata.grid.emptyHint')}</p>
                  </div>
                ) : null}
              </DataRegion>

              {showPagination ? (
                <Pagination
                  page={state.page}
                  pageCount={pageCount}
                  onPageChange={(page) => {
                    setState({ page });
                  }}
                  pageSize={pageSize}
                  onPageSizeChange={(nextSize) => {
                    setState({ pageSize: nextSize, page: 1 });
                  }}
                  totalCount={meta.showCount === false ? undefined : pagination.total}
                />
              ) : null}
            </>
          );
        }}
      </QueryBoundary>

      {withEditDialog ? (
        <EfficaFormDialog
          entity={entity}
          entityLabel={heading}
          mode={editDialog?.mode ?? 'edit'}
          id={editDialog?.id}
          record={editDialog?.record}
          row={editDialog?.row}
          tabs={dialogTabs}
          formProps={{ ...formProps, view: formProps?.view ?? view }}
          isOpen={editDialog !== null}
          onOpenChange={(open) => {
            if (!open) setEditDialog(null);
          }}
        />
      ) : null}
    </Stack>
  );
}

const badgeColorClass: Record<string, string> = {
  default: 'border border-border bg-surface-subtle text-fg',
  success: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  info: 'bg-info/10 text-info',
};

// Renders a cell per the column's server-declared CellRenderer. Unknown or
// absent renderer types fall back to the formatted text ('html' included —
// we never inject markup). Templates ('{field}' / '${field}') interpolate
// against the row.
function GridCellContent({
  column,
  row,
  text,
  dataIdScope,
}: {
  column: GridColumnMetadata;
  row: GridRow;
  text: string;
  dataIdScope?: string;
}) {
  const renderer = column.renderer as
    | {
        type?: string;
        color?: string;
        textField?: string;
        href?: string;
        src?: string;
        altField?: string;
      }
    | undefined;

  // The server stamps every base column with a default `{ type: 'text' }`
  // renderer, so "no explicit renderer" means absent OR text.
  const hasExplicitRenderer = renderer !== undefined && renderer.type !== 'text';

  // Boolean columns render as a read-only switch reflecting the value
  // (editing happens in the form). An explicit badge/link/avatar renderer
  // still wins. Detect by metadata dataType OR an actual boolean value.
  const rawValue = row[column.fieldKey];
  if (!hasExplicitRenderer && (column.dataType === 'boolean' || typeof rawValue === 'boolean')) {
    return (
      <Switch
        isSelected={rawValue === true}
        isReadOnly
        aria-label={column.label}
        data-testid={buildDataTestId(dataIdScope, 'switch')}
      />
    );
  }

  switch (renderer?.type) {
    case 'badge': {
      const label = renderer.textField ? toDisplayString(row[renderer.textField]) : text;
      return (
        <span
          data-testid={buildDataTestId(dataIdScope, 'badge')}
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            badgeColorClass[renderer.color ?? 'default'] ?? badgeColorClass.default,
          )}
        >
          {label}
        </span>
      );
    }
    case 'link': {
      const href = interpolateTemplate(renderer.href ?? '', row);
      const label = renderer.textField ? toDisplayString(row[renderer.textField]) : text;
      return (
        <Link href={href} data-testid={buildDataTestId(dataIdScope, 'link')}>
          {label}
        </Link>
      );
    }
    case 'avatar': {
      const src = interpolateTemplate(renderer.src ?? '', row);
      const alt = renderer.altField ? toDisplayString(row[renderer.altField]) : '';
      if (!src) return <>{text}</>;
      return (
        <img
          src={src}
          alt={alt}
          data-testid={buildDataTestId(dataIdScope, 'avatar')}
          className="size-7 rounded-full border border-border object-cover"
        />
      );
    }
    default:
      return <>{text}</>;
  }
}

function SortArrow({ dir }: { dir: 'asc' | 'desc' }) {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true" className="text-primary">
      {dir === 'asc' ? (
        <path d="M2 6.5 L5 3.5 L8 6.5" stroke="currentColor" strokeWidth={1.5} fill="none" />
      ) : (
        <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth={1.5} fill="none" />
      )}
    </svg>
  );
}
