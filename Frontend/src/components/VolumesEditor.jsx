import { Plus, Trash2, HardDrive } from 'lucide-react';

function VolumesEditor({ volumes = [], onChange }) {
  const list = Array.isArray(volumes) ? volumes : [];

  const handleUpdate = (index, field, val) => {
    const next = list.map((v, i) => (i === index ? { ...v, [field]: val } : v));
    onChange?.(next);
  };

  const handleAdd = () => {
    onChange?.([...list, { name: '', containerPath: '' }]);
  };

  const handleRemove = (index) => {
    onChange?.(list.filter((_, i) => i !== index));
  };

  return (
    <div className="volumes-editor">
      {list.length === 0 ? (
        <div className="empty-state-sm" style={{ padding: '12px' }}>
          No persistent volumes mounted. Files written inside the container reset on redeploy unless mounted here.
        </div>
      ) : (
        <div className="env-rows">
          {list.map((vol, idx) => (
            <div key={idx} className="env-row">
              <div className="input-with-icon" style={{ flex: '0 0 38%' }}>
                <input
                  type="text"
                  className="form-input"
                  value={vol.name || ''}
                  onChange={(e) => handleUpdate(idx, 'name', e.target.value)}
                  placeholder="Volume name"
                  aria-label={`Volume name ${idx + 1}`}
                />
              </div>
              <input
                type="text"
                className="form-input"
                value={vol.containerPath || ''}
                onChange={(e) => handleUpdate(idx, 'containerPath', e.target.value)}
                placeholder="Mount path"
                aria-label={`Volume mount path ${idx + 1}`}
              />
              <button
                type="button"
                className="btn btn-xs btn-danger env-remove-btn"
                onClick={() => handleRemove(idx)}
                title="Remove volume mount"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <button type="button" className="btn btn-xs btn-secondary" onClick={handleAdd}>
          <Plus size={12} /> Add Volume Mount
        </button>
        <span className="form-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <HardDrive size={11} /> Named Docker volumes survive deployments cleanly.
        </span>
      </div>
    </div>
  );
}

export default VolumesEditor;
